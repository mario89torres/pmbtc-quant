'use strict';

// Mantiene vivos el colector y el visor web. Es la única defensa real contra la
// pérdida definitiva de velas: gamma deja de servir los mercados viejos por slug,
// así que si el colector está caído cuando una vela cierra, ese dato no se
// recupera nunca. Reiniciar rápido acorta el hueco del feed lo suficiente para
// que backfill.js rescate la vela interrumpida desde `underlying`.
//
//   node pmbtc/supervise.js
//
// En Windows lo lanza la tarea programada PmbtcCollector al iniciar sesión;
// ver scripts/run-pmbtc.cmd.

const { spawn } = require('child_process');
const path = require('path');

const DIR = __dirname;
const ROOT = path.dirname(DIR);
const BACKFILL_EVERY_MS = 15 * 60 * 1000;
const MIN_BACKOFF = 2000;
const MAX_BACKOFF = 60000;
// Si aguanta vivo más que esto, la caída se considera puntual y no una crashloop.
const STABLE_MS = 5 * 60 * 1000;

const log = (...a) => console.log(new Date().toISOString(), '[sup]', ...a);

let stopping = false;

// Cada hijo se reinicia por separado: que se caiga el visor no debe tocar la
// captura, que es lo único cuyo dato es irrecuperable.
const HIJOS = [
  { nombre: 'colector', script: 'collect.js', backfillTrasReinicio: true },
  { nombre: 'visor', script: 'server.js', backfillTrasReinicio: false },
];

for (const h of HIJOS) {
  h.proc = null;
  h.backoff = MIN_BACKOFF;
  h.reinicios = 0;
}

function arrancar(h) {
  const desde = Date.now();
  h.proc = spawn(process.execPath, [path.join(DIR, h.script)], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  log(`${h.nombre} arrancado (pid ${h.proc.pid})`);

  h.proc.on('exit', (code, signal) => {
    h.proc = null;
    if (stopping) return;
    const vivo = Date.now() - desde;
    h.reinicios++;
    // Una caída tras un buen rato no es crashloop: se reinicia sin castigo.
    if (vivo > STABLE_MS) h.backoff = MIN_BACKOFF;
    log(`${h.nombre} murió (code ${code}, signal ${signal}) tras ${(vivo / 1000).toFixed(0)}s` +
        ` — reinicio nº${h.reinicios} en ${h.backoff}ms`);
    const espera = h.backoff;
    h.backoff = Math.min(h.backoff * 2, MAX_BACKOFF);
    setTimeout(() => {
      if (stopping) return;
      // Rescata la vela que quedó a medias antes de seguir.
      if (h.backfillTrasReinicio) backfill('tras reinicio');
      arrancar(h);
    }, espera);
  });

  h.proc.on('error', (e) => log(`${h.nombre} no pudo arrancar:`, e.message));
}

function backfill(motivo) {
  const p = spawn(process.execPath, [path.join(DIR, 'backfill.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('error', (e) => log('backfill no pudo arrancar:', e.message));
  p.on('exit', () => {
    const linea = out.split('\n').find((l) => /cambios|nada que recuperar/.test(l));
    log(`backfill (${motivo}): ${linea ? linea.trim() : 'sin salida'}`);
  });
}

const periodico = setInterval(() => backfill('periódico'), BACKFILL_EVERY_MS);

function cerrar(sig) {
  if (stopping) return;
  stopping = true;
  clearInterval(periodico);
  log(`recibido ${sig}, cerrando`);
  for (const h of HIJOS) if (h.proc) h.proc.kill();
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', () => cerrar('SIGINT'));
process.on('SIGTERM', () => cerrar('SIGTERM'));
process.on('unhandledRejection', (e) => log('RECHAZO NO CAPTURADO en el supervisor:', e && e.message));

log('supervisor iniciado');
for (const h of HIJOS) arrancar(h);
