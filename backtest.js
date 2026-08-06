'use strict';

// Evalúa la regla de src/strategy.js sobre las velas ya resueltas.
//
//   node pmbtc/backtest.js
//   node pmbtc/backtest.js --verbose    -> una línea por operación
//
// Reglas del ejercicio, elegidas para no engañarse:
//   - Una entrada por vela como mucho: la primera señal. Contar cada tick como
//     una operación multiplicaría por 100 un resultado que depende de 150 velas.
//   - Se compra al ASK (cruzando el spread), no al mid. El mid no es un precio
//     al que nadie te venda.
//   - σ se estima SOLO con datos anteriores al arranque de la vela. Usar la σ
//     global incluiría la volatilidad de la propia vela que se intenta predecir.
//   - Se mantiene hasta el vencimiento: paga 1 si acierta, 0 si falla.

const { open } = require('./src/db');
const { decidir, PARAMS } = require('./src/strategy');
const { BUCKET } = require('./src/gamma');

const verbose = process.argv.includes('--verbose');
const db = open();

// ---- σ sin mirar al futuro ----------------------------------------------------

const clRows = db
  .prepare("SELECT ts, price FROM underlying WHERE source='chainlink' ORDER BY ts")
  .all();

function sigmaAntesDe(tsMs, lookbackSec = 6 * 3600) {
  const desde = tsMs - lookbackSec * 1000;
  let sum = 0, n = 0, prev = null;
  for (const r of clRows) {
    if (r.ts < desde) continue;
    if (r.ts >= tsMs) break;
    if (prev) {
      const dt = (r.ts - prev.ts) / 1000;
      if (dt > 0 && dt <= 3) {
        const x = Math.log(r.price / prev.price) / Math.sqrt(dt);
        sum += x * x; n++;
      }
    }
    prev = r;
  }
  return n > 200 ? Math.sqrt(sum / n) : null;
}

// ---- z del basis por segundo --------------------------------------------------

const cl = new Map(), bn = new Map();
for (const r of clRows) cl.set(Math.floor(r.ts / 1000), r.price);
for (const r of db.prepare("SELECT ts, price FROM underlying WHERE source='binance'").all()) {
  bn.set(Math.floor(r.ts / 1000), r.price);
}

const zPorSeg = new Map();
{
  const ts = [...cl.keys()].filter((t) => bn.has(t)).sort((a, b) => a - b);
  let run = [];
  const cerrar = () => {
    if (run.length <= PARAMS.basisWindow) return;
    const basis = run.map((t) => Math.log(cl.get(t) / bn.get(t)));
    let acc = 0;
    for (let i = 0; i < run.length; i++) {
      acc += basis[i];
      if (i < PARAMS.basisWindow) continue;
      acc -= basis[i - PARAMS.basisWindow];
      zPorSeg.set(run[i], basis[i] - acc / PARAMS.basisWindow);
    }
  };
  for (const t of ts) {
    if (run.length && t === run[run.length - 1] + 1) run.push(t);
    else { cerrar(); run = [t]; }
  }
  cerrar();
}

// ---- recorrido ----------------------------------------------------------------

const velas = db
  .prepare('SELECT * FROM buckets WHERE outcome IS NOT NULL ORDER BY start_ts')
  .all();
const qTicks = db.prepare(
  'SELECT ts, t_left, cl_price, up_ask, down_ask FROM ticks WHERE start_ts=? ORDER BY ts'
);

// Se evalúa cada vela una vez por umbral. Barrer el umbral en vez de fijar uno
// evita el truco de enseñar el único valor que sale bien: si no hay ningún
// umbral rentable, se ve de golpe.
const UMBRALES = [0.005, 0.01, 0.02, 0.03, 0.05, 0.08];

function correr(minEdge) {
  const ops = [];
  let sinSenal = 0, sinSigma = 0;

  for (const v of velas) {
    const sigma = sigmaAntesDe(v.start_ts * 1000);
    if (sigma == null) { sinSigma++; continue; }

    let entrada = null;
    for (const t of qTicks.all(v.start_ts)) {
      const z = zPorSeg.get(Math.floor(t.ts / 1000));
      if (z == null) continue;
      const d = decidir({
        cl: t.cl_price, ref: v.ref_price, tLeft: t.t_left, sigma, z,
        upBid: t.up_bid, upAsk: t.up_ask, downAsk: t.down_ask,
      }, { ...PARAMS, minEdge });
      if (d && d.entrar) { entrada = { ...d, tLeft: t.t_left, ts: t.ts }; break; }
    }

    if (!entrada) { sinSenal++; continue; }

    const acierto = entrada.side === v.outcome;
    ops.push({
      startTs: v.start_ts,
      side: entrada.side,
      precio: entrada.precio,
      edge: entrada.edge,
      tLeft: entrada.tLeft,
      outcome: v.outcome,
      acierto,
      pnl: (acierto ? 1 : 0) - entrada.precio, // por 1 share
    });
  }
  return { ops, sinSenal, sinSigma };
}

const { ops, sinSenal, sinSigma } = correr(PARAMS.minEdge);

// ---- resultados ---------------------------------------------------------------

const iso = (s) => new Date(s * 1000).toISOString().slice(5, 16).replace('T', ' ');

if (verbose) {
  console.log('vela               lado  precio  edge  t_left  real   pnl');
  for (const o of ops) {
    console.log(
      `${iso(o.startTs)}   ${o.side.padEnd(5)} ${o.precio.toFixed(2)}  ${(100 * o.edge).toFixed(0).padStart(3)}c` +
      `  ${String(Math.round(o.tLeft)).padStart(4)}s  ${o.outcome.padEnd(5)} ${(o.pnl >= 0 ? '+' : '') + o.pnl.toFixed(2)}`
    );
  }
  console.log();
}

console.log('=== backtest ===');
console.log(`velas resueltas:      ${velas.length}`);
console.log(`  sin σ previa:       ${sinSigma}`);
console.log(`  sin señal:          ${sinSenal}`);
console.log(`  operaciones:        ${ops.length}`);

if (!ops.length) {
  console.log('\nNinguna entrada: la regla no encontró ventaja suficiente.');
  process.exit(0);
}

const aciertos = ops.filter((o) => o.acierto).length;
const pnl = ops.reduce((s, o) => s + o.pnl, 0);
const invertido = ops.reduce((s, o) => s + o.precio, 0);
const p = aciertos / ops.length;

// Intervalo de Wald al 95%. Con ~n=100 la anchura es lo que decide si esto
// significa algo, así que va junto al número y no en una nota al pie.
const se = Math.sqrt((p * (1 - p)) / ops.length);
const lo = p - 1.96 * se, hi = p + 1.96 * se;

// Umbral de rentabilidad: al precio medio pagado, cuánto hay que acertar.
const precioMedio = invertido / ops.length;

console.log(`\naciertos:             ${aciertos}/${ops.length} = ${(100 * p).toFixed(1)}%`);
console.log(`  IC 95%:             ${(100 * lo).toFixed(1)}% – ${(100 * hi).toFixed(1)}%`);
console.log(`precio medio pagado:  ${precioMedio.toFixed(3)}`);
console.log(`acierto de equilibrio:${(100 * precioMedio).toFixed(1)}%  <- hay que superar esto`);
console.log(`\nP&L total:            ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} por share`);
console.log(`ROI sobre lo invertido: ${((100 * pnl) / invertido).toFixed(1)}%`);

const veredicto =
  lo > precioMedio ? 'El IC queda por ENCIMA del equilibrio: señal positiva.'
  : hi < precioMedio ? 'El IC queda por DEBAJO del equilibrio: la regla pierde.'
  : 'El IC CRUZA el equilibrio: no se distingue de la nada.';
console.log(`\n${veredicto}`);

// ---- barrido de umbrales -------------------------------------------------------

console.log('\n=== barrido del umbral de entrada ===');
console.log('Si ningún umbral bate al equilibrio, no es cuestión de afinar el corte.\n');
console.log('  umbral   ops   acierto   equilibrio   ROI      veredicto');
for (const u of UMBRALES) {
  const r = correr(u);
  if (!r.ops.length) {
    console.log(`  ${(100 * u).toFixed(1).padStart(5)}c     0        —            —      —    sin entradas`);
    continue;
  }
  const pp = r.ops.filter((o) => o.acierto).length / r.ops.length;
  const inv = r.ops.reduce((s, o) => s + o.precio, 0);
  const pn = r.ops.reduce((s, o) => s + o.pnl, 0);
  const eq = inv / r.ops.length;
  const sd = Math.sqrt((pp * (1 - pp)) / r.ops.length);
  const bajo = pp - 1.96 * sd, alto = pp + 1.96 * sd;
  const v = bajo > eq ? 'GANA' : alto < eq ? 'pierde' : 'indistinguible';
  console.log(
    `  ${(100 * u).toFixed(1).padStart(5)}c  ${String(r.ops.length).padStart(4)}    ` +
    `${(100 * pp).toFixed(1).padStart(5)}%    ${(100 * eq).toFixed(1).padStart(5)}%   ` +
    `${((100 * pn) / inv).toFixed(1).padStart(6)}%  ${v}`
  );
}

console.log('\nLímites de esto:');
console.log(`- ${ops.length} operaciones son pocas. El IC de arriba ya lo dice, pero conviene repetirlo.`);
console.log('- Los parámetros se fijaron a priori y NO se han ajustado contra este P&L.');
console.log('  Si se tocan mirando el resultado, el número deja de valer.');
console.log('- Supone que se ejecuta al ask visible y al instante. Latencia real y');
console.log('  profundidad no están modeladas; `sweepCost()` en src/gamma.js es el');
console.log('  siguiente paso para eso.');
console.log('- Fees no incluidas: siguen sin confirmarse.');
