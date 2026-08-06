'use strict';

// ¿Binance adelanta a Chainlink? Chainlink es lo que resuelve el mercado, así que
// si Binance se mueve antes de forma sistemática, el futuro próximo del precio
// que resuelve es parcialmente conocido.
//
//   node pmbtc/lag.js
//
// Dos medidas independientes:
//   1. Correlación cruzada de retornos de 1 s a distintos desfases.
//   2. Reversión del basis: si chainlink va por detrás, cuando binance sube el
//      basis cae por debajo de su media y luego chainlink lo alcanza. Esta es la
//      forma accionable, porque el basis se observa en tiempo real.

const { open } = require('./src/db');

const db = open();
const MAX_LAG = 20;       // segundos a cada lado
const BASIS_WIN = 60;     // ventana de la media móvil del basis
const HORIZONS = [1, 2, 5, 10, 30, 60];

// ---- series alineadas ---------------------------------------------------------

function load(source) {
  const m = new Map();
  for (const r of db.prepare('SELECT ts, price FROM underlying WHERE source=? ORDER BY ts').all(source)) {
    m.set(Math.floor(r.ts / 1000), r.price);
  }
  return m;
}

const cl = load('chainlink');
const bn = load('binance');

// Tramos contiguos con ambas fuentes. Cortar en los huecos evita que una
// reconexión del feed se lea como un salto de precio.
const runs = [];
{
  let cur = null;
  for (const t of [...cl.keys()].sort((a, b) => a - b)) {
    if (!bn.has(t)) { cur = null; continue; }
    if (cur && t === cur.end + 1) cur.end = t;
    else { cur = { start: t, end: t }; runs.push(cur); }
  }
}
const usable = runs.filter((r) => r.end - r.start >= 120);
const totalSec = usable.reduce((s, r) => s + (r.end - r.start), 0);

console.log(`tramos contiguos usables: ${usable.length} | ${totalSec} s (${(totalSec / 3600).toFixed(2)} h)`);
if (totalSec < 1800) {
  console.log('muy poco dato para concluir nada; deja correr el colector');
}

// ---- utilidades ---------------------------------------------------------------

function corr(xs, ys) {
  const n = xs.length;
  if (n < 30) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

const bar = (v, scale = 0.5) => {
  const w = Math.round((Math.abs(v) / scale) * 30);
  return (v >= 0 ? ' ' : '-') + '█'.repeat(Math.min(30, w));
};

// ---- 1. correlación cruzada ---------------------------------------------------

// Retornos de 1 s por tramo, guardando el índice global para poder desfasar.
const rcl = [], rbn = [], seg = [];
for (const r of usable) {
  for (let t = r.start + 1; t <= r.end; t++) {
    rcl.push(Math.log(cl.get(t) / cl.get(t - 1)));
    rbn.push(Math.log(bn.get(t) / bn.get(t - 1)));
    seg.push(r.start);
  }
}

console.log('\n=== 1. correlación cruzada de retornos de 1 s ===');
console.log('desfase>0 = binance adelanta. corr(retorno binance en t-k, retorno chainlink en t)\n');
console.log('  k(s)     corr   n');
let best = { k: null, c: -Infinity };
const curva = [];
for (let k = -MAX_LAG; k <= MAX_LAG; k++) {
  const xs = [], ys = [];
  for (let i = 0; i < rcl.length; i++) {
    const j = i - k;
    if (j < 0 || j >= rbn.length) continue;
    if (seg[i] !== seg[j]) continue; // no cruzar tramos
    xs.push(rbn[j]); ys.push(rcl[i]);
  }
  const c = corr(xs, ys);
  curva.push({ k, c, n: xs.length });
  if (c != null && c > best.c) best = { k, c };
}
const escala = Math.max(...curva.map((r) => (r.c == null ? 0 : Math.abs(r.c))));
for (const r of curva) {
  const mark = r.k === best.k ? '  <- pico' : '';
  console.log(
    `  ${String(r.k).padStart(4)}  ${r.c == null ? '  n/a' : r.c.toFixed(3).padStart(7)}  ${String(r.n).padStart(6)} ${r.c == null ? '' : bar(r.c, escala || 1)}${mark}`
  );
}
console.log(`\npico en k=${best.k}s (corr ${best.c.toFixed(3)})`);
console.log(best.k > 0
  ? `-> binance adelanta ~${best.k}s a chainlink`
  : best.k === 0
    ? '-> se mueven a la vez: no hay adelanto explotable a resolución de 1s'
    : `-> chainlink adelanta ~${-best.k}s a binance (inesperado; sospechar del dato)`);

// ---- 2. reversión del basis ---------------------------------------------------

console.log('\n=== 2. ¿el basis predice el movimiento futuro de chainlink? ===');
console.log(`basis = ln(cl/bn), desviado de su media móvil de ${BASIS_WIN}s.`);
console.log('Si chainlink va por detrás, basis bajo => chainlink sube: correlación NEGATIVA.\n');

// z del basis y retorno futuro de chainlink, por tramo.
const rows = [];
for (const r of usable) {
  const ts = [];
  for (let t = r.start; t <= r.end; t++) ts.push(t);
  const basis = ts.map((t) => Math.log(cl.get(t) / bn.get(t)));
  let acc = 0;
  for (let i = 0; i < basis.length; i++) {
    acc += basis[i];
    if (i < BASIS_WIN) continue;
    acc -= basis[i - BASIS_WIN];
    const z = basis[i] - acc / BASIS_WIN;
    rows.push({ run: r.start, i, t: ts[i], z, price: cl.get(ts[i]) });
  }
}

console.log('  horizonte    corr      n   acierto de signo   |mov| medio');
for (const h of HORIZONS) {
  const zs = [], fs = [];
  let hits = 0, tot = 0, absMove = 0;
  for (const row of rows) {
    const fut = cl.get(row.t + h);
    if (fut == null) continue;
    // No cruzar huecos: exigir que el segundo futuro esté en el mismo tramo.
    const run = usable.find((r) => r.start === row.run);
    if (!run || row.t + h > run.end) continue;
    const fr = Math.log(fut / row.price);
    zs.push(row.z); fs.push(fr);
    if (fr !== 0) { tot++; if (Math.sign(fr) === Math.sign(-row.z)) hits++; }
    absMove += Math.abs(fut - row.price);
  }
  const c = corr(zs, fs);
  console.log(
    `  ${(h + 's').padStart(9)}  ${c == null ? '  n/a' : c.toFixed(3).padStart(6)}  ${String(zs.length).padStart(6)}` +
    `        ${tot ? ((100 * hits) / tot).toFixed(1) + '%' : ' n/a'}      $${zs.length ? (absMove / zs.length).toFixed(2) : '—'}`
  );
}

// Acierto por intensidad de la señal: si el basis extremo no acierta más que el
// basis flojo, no hay señal, solo ruido correlacionado.
console.log('\n=== 3. acierto por intensidad del basis (horizonte 10s) ===');
const H = 10;
const muestras = [];
for (const row of rows) {
  const run = usable.find((r) => r.start === row.run);
  if (!run || row.t + H > run.end) continue;
  const fut = cl.get(row.t + H);
  if (fut == null) continue;
  const fr = fut - row.price;
  if (fr === 0) continue;
  muestras.push({ z: row.z, fr });
}
muestras.sort((a, b) => Math.abs(a.z) - Math.abs(b.z));
const Q = 5;
console.log('  quintil |z|      n   acierto   mov medio a favor');
for (let q = 0; q < Q; q++) {
  const lo = Math.floor((q * muestras.length) / Q);
  const hi = Math.floor(((q + 1) * muestras.length) / Q);
  const trozo = muestras.slice(lo, hi);
  if (!trozo.length) continue;
  const hits = trozo.filter((m) => Math.sign(m.fr) === Math.sign(-m.z)).length;
  const favor = trozo.reduce((s, m) => s + Math.sign(-m.z) * m.fr, 0) / trozo.length;
  console.log(
    `  ${(q + 1) + '/' + Q}          ${String(trozo.length).padStart(6)}    ${((100 * hits) / trozo.length).toFixed(1)}%      ${favor >= 0 ? '+' : ''}$${favor.toFixed(2)}`
  );
}

// ---- 4. ¿el basis aporta algo SOBRE el precio del mercado? --------------------
// Es la única pregunta que importa. Que el basis prediga a chainlink no sirve de
// nada si el mercado ya lo está descontando. La prueba: dentro de un mismo nivel
// de precio del mercado, ¿el signo del basis separa los resultados reales?

console.log('\n=== 4. ¿el basis aporta información SOBRE el precio del mercado? ===');

const resueltas = db.prepare("SELECT start_ts, outcome FROM buckets WHERE outcome IS NOT NULL").all();
const qt = db.prepare(
  'SELECT ts, t_left, cl_price, bn_price, up_bid, up_ask FROM ticks WHERE start_ts=? ORDER BY ts'
);

// z del basis reutilizando la media móvil ya calculada, indexada por segundo.
const zBySec = new Map();
for (const row of rows) zBySec.set(row.t, row.z);

const celdas = new Map(); // `${decil}|${signo}` -> {n, up}
let usados = 0;
for (const b of resueltas) {
  for (const t of qt.all(b.start_ts)) {
    if (t.up_bid == null || t.up_ask == null || t.cl_price == null || t.bn_price == null) continue;
    const z = zBySec.get(Math.floor(t.ts / 1000));
    if (z == null) continue;
    const mid = (t.up_bid + t.up_ask) / 2;
    const dec = Math.min(9, Math.max(0, Math.floor(mid * 10)));
    // z<0 => chainlink por detrás => se espera que suba => favorece Up.
    const signo = z < 0 ? 'favorece Up' : 'favorece Down';
    const k = `${dec}|${signo}`;
    const e = celdas.get(k) || { n: 0, up: 0, sum: 0 };
    e.n++; e.sum += mid;
    if (b.outcome === 'Up') e.up++;
    celdas.set(k, e);
    usados++;
  }
}

if (!usados) {
  console.log('  sin solape entre ticks del libro y basis todavía');
} else {
  console.log(`  ${resueltas.length} velas resueltas, ${usados} ticks con basis\n`);
  console.log('  mid Up    señal            n   implícita   real    dif');
  for (let d = 0; d < 10; d++) {
    const filas = ['favorece Up', 'favorece Down']
      .map((s) => ({ s, e: celdas.get(`${d}|${s}`) }))
      .filter((x) => x.e && x.e.n >= 20);
    if (filas.length < 2) continue; // sin las dos ramas no hay comparación
    for (const { s, e } of filas) {
      const imp = e.sum / e.n, real = e.up / e.n;
      console.log(
        `  ${(d / 10).toFixed(1)}-${((d + 1) / 10).toFixed(1)}   ${s.padEnd(14)} ${String(e.n).padStart(5)}` +
        `      ${(100 * imp).toFixed(1)}%   ${(100 * real).toFixed(1)}%   ${((real - imp) * 100 >= 0 ? '+' : '') + ((real - imp) * 100).toFixed(1)}`
      );
    }
  }
  console.log('\n  Si el basis aportara algo, dentro de un mismo nivel de precio la rama');
  console.log('  "favorece Up" debería acabar en Up más a menudo que la rama "favorece Down".');
  console.log('  Con pocas velas esto NO puede concluir nada: todos los ticks de una vela');
  console.log('  comparten resultado, así que el n real es el número de velas, no de ticks.');
}

console.log('\nAdvertencias:');
console.log('- Las ventanas se solapan, así que el n efectivo es mucho menor que el mostrado.');
console.log('- Chainlink es un feed agregado/suavizado: parte de la reversión del basis es');
console.log('  mecánica (media móvil del mismo subyacente), no información nueva. Sigue siendo');
console.log('  predecible, pero explica por qué el "adelanto" aparece sin que nadie lo arbitre.');
console.log('- Para que esto sea explotable, el movimiento esperado debe superar el spread del');
console.log('  libro (~1 centavo) traducido a probabilidad, no solo tener el signo correcto.');
