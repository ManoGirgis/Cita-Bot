// Uso: node bot.js
//      node bot.js --provincia=Madrid --oficinas=Getafe,Alcalá --intervalo=180
const { chromium } = require('playwright');
const cfg = require('./config.json');

// --- Opciones desde la línea de comandos (sobrescriben config.json) ---
const args = Object.fromEntries(
  process.argv.filter(a => a.startsWith('--')).map(a => a.slice(2).split('='))
);
if (args.provincia) cfg.provincia = args.provincia;
if (args.oficinas) cfg.oficinas = args.oficinas.split(',').map(s => s.trim()).filter(Boolean);
if (args.intervalo) cfg.intervaloSegundos = Number(args.intervalo);

const URL = 'https://icp.administracionelectronica.gob.es/icpplus/index.html';
const SIN_CITAS = /no hay citas disponibles|no hi ha cites disponibles/i;

async function avisar(texto) {
  console.log(texto);
  if (!cfg.telegram || !cfg.telegram.token) return;
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

let avisoCaptchaEnviado = false;

async function intentar(page) {
  await page.goto(URL);

  // ⚠️ Los selectores son los habituales de la sede; si algo falla, inspecciona la página (F12).
  await page.selectOption('#form', { label: cfg.provincia });
  await page.click('#btnAceptar');

  await page.selectOption('#tramiteGrupo\\[0\\]', { label: cfg.tramite });
  await page.click('#btnAceptar');
  await page.click('#btnEntrar');

  await page.fill('#txtIdCitado', cfg.persona.nie);
  await page.fill('#txtDesCitado', cfg.persona.nombre);
  await page.selectOption('#txtPaisNac', { label: cfg.persona.pais });

  // La persona resuelve el captcha y pulsa los botones (Aceptar / Solicitar cita).
  if (!avisoCaptchaEnviado) {
    await avisar('⚠️ Resuelve el captcha y pulsa "Aceptar" y "Solicitar cita" en el navegador.');
    avisoCaptchaEnviado = true;
  }

  // Esperamos al resultado: o aparece el selector de oficinas (hay citas) o el mensaje de "no hay citas".
  const oficinas = page.locator('#idSede');
  const mensajeSinCitas = page.getByText(SIN_CITAS);
  await oficinas.or(mensajeSinCitas).first().waitFor({ timeout: 0 });

  if (await oficinas.count() === 0) return false; // no hay citas

  // Hay citas: miramos en qué oficinas.
  const opciones = await page.$$eval('#idSede option', os =>
    os.map(o => o.textContent.trim()).filter(t => t && !/seleccion/i.test(t))
  );
  const quiero = cfg.oficinas.map(s => s.toLowerCase());
  const validas = quiero.length
    ? opciones.filter(o => quiero.some(q => o.toLowerCase().includes(q)))
    : opciones;

  if (validas.length === 0) {
    console.log('Hay citas, pero no en tus oficinas:', opciones.join(' | '));
    return false;
  }

  await avisar(`✅ ¡Hay citas en ${cfg.provincia}! Oficinas: ${validas.join(', ')}. Ve al navegador y confirma ya.`);
  return true;
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  while (true) {
    try {
      if (await intentar(page)) break;
    } catch (e) {
      console.log('Error, reintentando:', e.message);
    }
    await new Promise(r => setTimeout(r, cfg.intervaloSegundos * 1000));
  }

  // Dejamos el navegador abierto para que la persona confirme la cita.
  await new Promise(() => {});
})();

cfg.telegram = cfg.telegram || {};
if (process.env.TG_TOKEN) cfg.telegram.token = process.env.TG_TOKEN;
if (process.env.TG_CHAT_ID) cfg.telegram.chatId = process.env.TG_CHAT_ID;
