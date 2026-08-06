'use strict';

const fs = require('fs');
const path = require('path');
const { open } = require('./src/db');
const { sigmaPerSecond, fairUp } = require('./src/model');

const db = open();
const { sigma } = sigmaPerSecond(db);

console.log('--- Extrayendo datos para entrenamiento de Machine Learning ---');

const buckets = db.prepare("SELECT * FROM buckets WHERE outcome IS NOT NULL ORDER BY start_ts ASC").all();
console.log(`Velas resueltas encontradas: ${buckets.length}`);

const tickQuery = db.prepare("SELECT * FROM ticks WHERE start_ts=? ORDER BY ts ASC");

const dataset = [];

for (const b of buckets) {
  const ticks = tickQuery.all(b.start_ts);
  const target = b.outcome === 'Up' ? 1 : 0;
  const ref = b.ref_price;

  if (!ref || !ticks.length) continue;

  for (const t of ticks) {
    if (t.cl_price == null || t.t_left <= 0) continue;

    const cl = t.cl_price;
    const bn = t.bn_price ?? cl;
    const tLeft = t.t_left;
    const dist = cl - ref;

    let zScore = 0;
    if (sigma && sigma > 0 && tLeft > 0 && cl > 0 && ref > 0) {
      zScore = Math.log(cl / ref) / (sigma * Math.sqrt(tLeft));
    }

    const basis = cl - bn;
    const upBid = t.up_bid ?? 0.5;
    const upAsk = t.up_ask ?? 0.5;
    const dnBid = t.down_bid ?? 0.5;
    const dnAsk = t.down_ask ?? 0.5;

    const spread = upAsk - upBid;
    const crossCost = upAsk + dnAsk - 1;
    const upDepth = t.up_depth_usd ?? 0;
    const dnDepth = t.dn_depth_usd ?? 0;
    const totalDepth = upDepth + dnDepth;
    const imbalance = totalDepth > 0 ? (upDepth - dnDepth) / totalDepth : 0;

    const pGbm = fairUp(cl, ref, tLeft, sigma) ?? (cl >= ref ? 0.55 : 0.45);

    dataset.push({
      start_ts: b.start_ts,
      t_left: Number(tLeft.toFixed(1)),
      cl_price: Number(cl.toFixed(2)),
      ref_price: Number(ref.toFixed(2)),
      dist: Number(dist.toFixed(2)),
      dist_pct: Number(((dist / ref) * 100).toFixed(4)),
      z_score: Number(zScore.toFixed(4)),
      basis: Number(basis.toFixed(2)),
      spread: Number(spread.toFixed(4)),
      cross_cost: Number(crossCost.toFixed(4)),
      imbalance: Number(imbalance.toFixed(4)),
      p_gbm: Number(pGbm.toFixed(4)),
      target,
    });
  }
}

console.log(`Total de muestras procesadas: ${dataset.length}`);

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const outputPath = path.join(dataDir, 'ml_dataset.json');
fs.writeFileSync(outputPath, JSON.stringify(dataset, null, 2));

console.log(`Dataset guardado exitosamente en: ${outputPath}`);
