// Uso:  node bot.js
//       node bot.js --provincia=Madrid --oficinas=Getafe,Alcala --intervalo=3600
//       node bot.js --una-vez     (hace una sola comprobación y sale; para el Programador de tareas)
//       node bot.js --depurar     (se para en el primer error)
require('dotenv').config();
const { chromium } = require('playwright');
const cfg = require('./config.json');

// ---------- Configuración (config.json + .env + línea de comandos) ----------
const args = Object.fromEntries(
  process.argv.filter(a => a.startsWith('--')).map(a => a.slice(2).split('='))
);
if (args.provincia) cfg.provincia = args.provincia;
if (args.oficinas) cfg.oficinas = args.oficinas.split(',').map(s => s.trim()).filter(Boolean);
if (args.intervalo) cfg.intervaloSegundos = Number(args.intervalo);

cfg.telegram = cfg.telegram || {};
if (process.env.TG_TOKEN) cfg.telegram.token = process.env.TG_TOKEN;
if (process.env.TG_CHAT_ID) cfg.telegram.chatId = process.env.TG_CHAT_ID;
cfg.oficinas = cfg.oficinas || [];
cfg.horarios = cfg.horarios || [];                       // ej. ["08:00-10:00", "12:00-13:30"]; vacío = siempre
cfg.avisos = { captcha: false, bloqueo: true, ...(cfg.avisos || {}) };
cfg.intervaloSegundos = cfg.intervaloSegundos || 3600;
cfg.esperaCaptchaMinutos = cfg.esperaCaptchaMinutos || 10;

const URL = 'https://icp.administracionelectronica.gob.es/icpplus/index.html';
const SIN_CITAS = /no hay citas disponibles|no hi ha cites disponibles/i;
const BLOQUEO = /requested url was rejected|url solicitada fue rechazada/i;
const MAX_FALLOS_SEGUIDOS = 5;

// ---------- Utilidades ----------
const esperar = ms => new Promise(r => setTimeout(r, ms));
const normalizar = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Telegram SOLO se usa para: citas encontradas, bloqueo y parada por errores.
async function avisar(texto, { telegram = true } = {}) {
  console.log(texto);
  if (!telegram || !cfg.telegram.token || !cfg.telegram.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: texto }),
    });
  } catch (e) {
    console.log('No se pudo enviar el aviso a Telegram:', e.message);
  }
}

function minutos(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function dentroDeHorario(ahora = new Date()) {
  if (!cfg.horarios.length) return true;
  const min = ahora.getHours() * 60 + ahora.getMinutes();
  return cfg.horarios.some(rango => {
    const [a, b] = rango.split('-').map(s => minutos(s.trim()));
    return a <= b ? min >= a && min <= b : min >= a || min <= b;
  });
}

async function hayBloqueo(page) {
  const texto = await page.textContent('body').catch(() => '');
  return BLOQUEO.test(texto || '');
}

// Elige la opción cuyo texto CONTIENE el fragmento (sin importar mayúsculas ni tildes).
async function seleccionarPorTexto(page, selector, fragmento) {
  const buscado = normalizar(fragmento);
  await page.waitForSelector(`${selector} option`, { state: 'attached' }); // espera a que exista el desplegable
  const opciones = await page.$$eval(`${selector} option`, os =>
    os.map(o => ({ valor: o.value, texto: o.textContent.trim() }))
  );
  const op = opciones.find(o => o.valor && normalizar(o.texto).includes(buscado));
  if (!op) throw new Error(`Ninguna opción contiene "${fragmento}" en ${selector}`);
  await page.selectOption(selector, op.valor);
}

async function diagnostico(page, nombre, e) {
  console.log(`\n❌ Falló el paso: ${nombre}`);
  console.log(e.message.split('\n')[0]);
  console.log('URL:', page.url());
  try {
    console.log('Título:', await page.title());
    const texto = ((await page.innerText('body')) || '').replace(/\s+/g, ' ').trim();
    console.log('Texto visible:', texto.slice(0, 400));
  } catch (_) {}
  try {
    await page.screenshot({ path: 'error.png', fullPage: true });
    const selects = await page.$$eval('select', ss => ss.map(s => ({
      id: s.id,
      name: s.name,
      opciones: [...s.options].map(o => o.textContent.trim()).slice(0, 60),
    })));
    const verOpciones = /provincia|trámite|país/.test(nombre);
    console.log('Desplegables:', JSON.stringify(
      verOpciones ? selects : selects.map(s => ({ id: s.id, nOpciones: s.opciones.length })), null, 2));
  } catch (_) {}
}

async function paso(page, nombre, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(await hayBloqueo(page))) await diagnostico(page, nombre, e);
    throw e;
  }
}

// ---------- Enviar el formulario y pedir cita ----------
// Pulsa "Aceptar" / "Solicitar cita" solo. Si aparece un captcha, espera a que lo resuelva la PERSONA.
const CAPTCHA = 'iframe[src*="recaptcha" i], .g-recaptcha, iframe[src*="hcaptcha" i], img[src*="captcha" i], input[name*="captcha" i]';

async function solicitarCita(page) {
  const oficinas = page.locator('#idSede');
  const sinCitas = page.getByText(SIN_CITAS);
  const hayResultado = async () => (await oficinas.count()) > 0 || (await sinCitas.count()) > 0;

  for (let i = 0; i < 6; i++) {
    if (await hayResultado()) return true;

    if ((await page.locator(CAPTCHA).count()) > 0) {
      await avisar('⏳ Hay captcha: resuélvelo en el navegador.', { telegram: cfg.avisos.captcha });
      process.stdout.write('\x07');
      try {
        await oficinas.or(sinCitas).first().waitFor({ timeout: cfg.esperaCaptchaMinutos * 60 * 1000 });
        return true;
      } catch (_) {
        console.log(`Nadie resolvió el captcha en ${cfg.esperaCaptchaMinutos} min; reintento más tarde.`);
        return false;
      }
    }

    const boton = page.locator('#btnEnviar');
    if ((await boton.count()) > 0 && (await boton.first().isVisible())) {
      await boton.first().click();
      await page.waitForLoadState('load').catch(() => {});
      await esperar(1500);
    } else {
      await esperar(1000);
    }
  }
  await oficinas.or(sinCitas).first().waitFor({ timeout: 15000 });
  return true;
}

// ---------- Un intento completo ----------
async function intentar(page) {
  await paso(page, 'abrir la sede', () => page.goto(URL));

  await paso(page, 'provincia', () => seleccionarPorTexto(page, '#form', cfg.provincia));
  await paso(page, 'aceptar (provincia)', () => page.click('#btnAceptar'));

  await paso(page, 'trámite', async () => {
    await seleccionarPorTexto(page, '#tramiteGrupo\\[0\\]', cfg.tramite);
    await page.waitForLoadState('networkidle').catch(() => {}); // la página carga avisos al elegir trámite
    await esperar(1500);
  });
  await paso(page, 'aceptar (trámite)', async () => {
    await page.click('#btnAceptar');
    await page.waitForSelector('#btnEntrar', { timeout: 30000 }); // esperamos a la página siguiente
  });
  await paso(page, 'entrar', () => page.click('#btnEntrar'));

  await paso(page, 'NIE', () => page.fill('#txtIdCitado', cfg.persona.nie));
  await paso(page, 'nombre', () => page.fill('#txtDesCitado', cfg.persona.nombre));
  await paso(page, 'país', () => seleccionarPorTexto(page, '#txtPaisNac', cfg.persona.pais));

  const hayResultado = await paso(page, 'solicitar cita', () => solicitarCita(page));
  if (!hayResultado) return false; // captcha sin resolver

  const hora = new Date().toLocaleTimeString('es-ES');
  if ((await page.locator('#idSede').count()) === 0) {
    console.log(`[${hora}] Sin citas por ahora.`);
    return false;
  }

  const opciones = await page.$$eval('#idSede option', os =>
    os.map(o => o.textContent.trim()).filter(t => t && !/seleccion/i.test(t))
  );
  const quiero = cfg.oficinas.map(normalizar);
  const validas = quiero.length
    ? opciones.filter(o => quiero.some(q => normalizar(o).includes(q)))
    : opciones;

  if (validas.length === 0) {
    console.log('Hay citas, pero no en tus oficinas:', opciones.join(' | '));
    return false;
  }

  process.stdout.write('\x07\x07\x07');
  await avisar(`✅ ¡Hay citas en ${cfg.provincia}! Oficinas: ${validas.join(', ')}. Ve al navegador y confirma YA.`);
  return true;
}

// ---------- Bucle principal ----------
(async () => {
  const opcionesNavegador = { headless: !!cfg.headless };
  if (cfg.canal) opcionesNavegador.channel = cfg.canal; // "chrome" o "msedge"
  const browser = await chromium.launch(opcionesNavegador);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);

  let fallos = 0;
  let avisadoFueraDeHorario = false;

  while (true) {
    if (!dentroDeHorario()) {
      if (!avisadoFueraDeHorario) {
        console.log(`Fuera de horario (${cfg.horarios.join(', ')}). Espero...`);
        avisadoFueraDeHorario = true;
      }
      await esperar(60 * 1000);
      continue;
    }
    avisadoFueraDeHorario = false;

    try {
      if (await intentar(page)) break; // ¡citas! salimos del bucle
      fallos = 0;
      if ('una-vez' in args) { await browser.close(); process.exit(0); } // para el Programador de tareas
    } catch (e) {
      if (await hayBloqueo(page)) {
        await avisar('🚫 La sede ha bloqueado el acceso. Pauso 60 minutos.', { telegram: cfg.avisos.bloqueo });
        if ('una-vez' in args) process.exit(0);
        await esperar(60 * 60 * 1000);
        fallos = 0;
        continue;
      }
      fallos++;
      console.log(`Error (${fallos}/${MAX_FALLOS_SEGUIDOS}):`, e.message.split('\n')[0]);
      if ('depurar' in args || 'una-vez' in args) process.exit(1); // --depurar / --una-vez
      if (fallos >= MAX_FALLOS_SEGUIDOS) {
        await avisar(`❌ El bot se ha parado tras ${MAX_FALLOS_SEGUIDOS} errores seguidos: ${e.message.split('\n')[0]}`);
        process.exit(1);
      }
    }

    // Espera con variación aleatoria (±) para no hacer peticiones a intervalos exactos.
    const variacion = cfg.variacion ?? 0.15; // ±15 % por defecto
    await esperar(cfg.intervaloSegundos * 1000 * (1 + (Math.random() * 2 - 1) * variacion));
  }

  // Dejamos el navegador abierto para que la persona confirme la cita.
  console.log('Navegador abierto: confirma la cita manualmente. Ctrl+C para salir.');
  await new Promise(() => {});
})();

module.exports = { dentroDeHorario, normalizar };