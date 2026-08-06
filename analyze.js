'use strict';

// Lectura de lo que grabó collect.js. No decide nada: describe.
//
//   node pmbtc/analyze.js            -> resumen general
//   node pmbtc/analyze.js <start_ts> -> detalle tick a tick de un bucket

const { open } = require('./src/db');
const { sigmaPerSecond, fairUp } = require('./src/model');

const db = open();
const arg = process.argv[2];

const pct = (x) => (x == null ? '  n/a' : (100 * x).toFixed(1).padStart(5));
const f2 = (x) => (x == null ? 'n/a' : x.toFixed(2));

// ---- detalle de un bucket ----------------------------------------------------

function detail(startTs) {
  const b = db.prepare('SELECT * FROM buckets WHERE start_ts = ?').get(Number(startTs));
  if (!b) return console.log('no hay bucket', startTs);
  const { sigma } = sigmaPerSecond(db);
  console.log(`\n${b.question}`);
  console.log(`slug ${b.slug}`);
  console.log(
    `ref ${f2(b.ref_price)}  final ${f2(b.final_price)}  outcome ${b.outcome || '-'}  settled_up ${b.settled_up ?? '-'}`
  );
  console.log(`sigma/s estimada ${sigma ? sigma.toExponential(3) : 'n/a'}\n`);
  console.log('t_left  chainlink   drift   up_bid up_ask  dn_bid dn_ask   mid_up  fair_up   edge  depth$');
  const ticks = db.prepare('SELECT * FROM ticks WHERE start_ts = ? ORDER BY ts').all(Number(startTs));
  for (const t of ticks) {
    const ref = t.ref_price ?? b.ref_price;
    const drift = t.cl_price != null && ref != null ? t.cl_price - ref : null;
    const mid = t.up_bid != null && t.up_ask != null ? (t.up_bid + t.up_ask) / 2 : null;
    const fair = fairUp(t.cl_price, ref, t.t_left, sigma);
    const edge = fair != null && t.up_ask != null ? fair - t.up_ask : null;
    console.log(
      [
        t.t_left.toFixed(0).padStart(6),
        f2(t.cl_price).padStart(10),
        (drift == null ? 'n/a' : (drift >= 0 ? '+' : '') + drift.toFixed(2)).padStart(8),
        f2(t.up_bid).padStart(7),
        f2(t.up_ask).padStart(6),
        f2(t.down_bid).padStart(8),
        f2(t.down_ask).padStart(6),
        pct(mid).padStart(8),
        pct(fair).padStart(8),
        (edge == null ? 'n/a' : (edge >= 0 ? '+' : '') + (100 * edge).toFixed(1)).padStart(7),
        Math.round(t.up_depth_usd || 0).toString().padStart(7),
      ].join(' ')
    );
  }
}

// ---- resumen -----------------------------------------------------------------

function summary() {
  const u = db
    .prepare(
      "SELECT source, COUNT(*) n, MIN(ts) a, MAX(ts) b FROM underlying GROUP BY source"
    )
    .all();
  console.log('=== subyacente ===');
  for (const r of u) {
    const span = (r.b - r.a) / 60000;
    console.log(
      `${r.source.padEnd(10)} ${r.n} ticks en ${span.toFixed(1)} min (cobertura ${(
        (100 * r.n) / Math.max(1, span * 60)
      ).toFixed(0)}%)`
    );
  }
  const { sigma, samples } = sigmaPerSecond(db);
  if (sigma) {
    const s15 = sigma * Math.sqrt(900);
    console.log(
      `sigma/s ${sigma.toExponential(3)} (${samples} retornos) -> sigma 15min ${(100 * s15).toFixed(3)}%`
    );
  } else {
    console.log('sigma: aún no hay suficientes retornos');
  }

  const buckets = db.prepare('SELECT * FROM buckets ORDER BY start_ts').all();
  console.log(`\n=== buckets (${buckets.length}) ===`);
  console.log('start_ts     hora    ref        final      mov     out   settled  ticks');
  for (const b of buckets) {
    const n = db.prepare('SELECT COUNT(*) c FROM ticks WHERE start_ts=?').get(b.start_ts).c;
    const mov = b.final_price != null && b.ref_price != null ? b.final_price - b.ref_price : null;
    console.log(
      [
        String(b.start_ts),
        new Date(b.start_ts * 1000).toISOString().slice(11, 16),
        f2(b.ref_price).padStart(10),
        f2(b.final_price).padStart(10),
        (mov == null ? 'n/a' : (mov >= 0 ? '+' : '') + mov.toFixed(2)).padStart(8),
        (b.outcome || '-').padStart(5),
        String(b.settled_up ?? '-').padStart(8),
        String(n).padStart(6),
      ].join(' ')
    );
  }

  // Calibración: ¿el precio del mercado acierta? Agrupado por prob implícita.
  const resolved = buckets.filter((b) => b.outcome);
  if (resolved.length) {
    console.log(`\n=== calibración del mercado (${resolved.length} buckets resueltos) ===`);
    const bins = new Map();
    for (const b of resolved) {
      const ticks = db
        .prepare('SELECT t_left, up_bid, up_ask FROM ticks WHERE start_ts=? ORDER BY ts')
        .all(b.start_ts);
      for (const t of ticks) {
        if (t.up_bid == null || t.up_ask == null) continue;
        const mid = (t.up_bid + t.up_ask) / 2;
        const key = Math.min(9, Math.floor(mid * 10));
        const e = bins.get(key) || { n: 0, up: 0, sum: 0 };
        e.n++;
        e.sum += mid;
        if (b.outcome === 'Up') e.up++;
        bins.set(key, e);
      }
    }
    console.log('mid_up      n   implícita   real   sesgo');
    for (const key of [...bins.keys()].sort((a, b) => a - b)) {
      const e = bins.get(key);
      const imp = e.sum / e.n;
      const real = e.up / e.n;
      console.log(
        `${(key / 10).toFixed(1)}-${((key + 1) / 10).toFixed(1)} ${String(e.n).padStart(6)}   ${pct(imp)}%  ${pct(real)}%  ${((real - imp) * 100 >= 0 ? '+' : '') + ((real - imp) * 100).toFixed(1)}`
      );
    }
    console.log('(cada fila son ticks, no eventos independientes: es descriptivo, no un test)');
  }

  // Coste real de cruzar el spread, que es lo que se come cualquier edge.
  const sp = db
    .prepare(
      `SELECT AVG(up_ask - up_bid) s, AVG(up_ask + down_ask - 1) v, COUNT(*) n
       FROM ticks WHERE up_bid IS NOT NULL AND up_ask IS NOT NULL AND down_ask IS NOT NULL`
    )
    .get();
  if (sp.n) {
    console.log('\n=== microestructura ===');
    console.log(`spread medio Up: ${(100 * sp.s).toFixed(2)} centavos`);
    console.log(`up_ask + down_ask - 1: ${(100 * sp.v).toFixed(2)} centavos (coste de cruzar)`);
    const d = db
      .prepare('SELECT AVG(up_depth_usd) u, AVG(dn_depth_usd) d, MIN(up_depth_usd) mu FROM ticks')
      .get();
    console.log(`profundidad media en asks: Up $${Math.round(d.u)} / Down $${Math.round(d.d)}`);
  }
}

if (arg) detail(arg);
else summary();
