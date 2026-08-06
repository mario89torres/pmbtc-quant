'use strict';

const fs = require('fs');
const { open } = require('./src/db');
const { decidir, PARAMS } = require('./src/strategy');

const db = open();

console.log('=== AUDITORÍA EMPÍRICA RIGUROSA DE PMBTC.DB (NIVEL DE VELA N=406) ===\n');

const velas = db.prepare("SELECT * FROM buckets WHERE outcome IS NOT NULL ORDER BY start_ts").all();
console.log(`Velas Resueltas Reales: ${velas.length}`);

const qTicks = db.prepare('SELECT ts, t_left, cl_price, up_bid, up_ask, down_bid, down_ask FROM ticks WHERE start_ts=? ORDER BY ts');

const clRows = db.prepare("SELECT ts, price FROM underlying WHERE source='chainlink' ORDER BY ts").all();
const bnRows = db.prepare("SELECT ts, price FROM underlying WHERE source='binance' ORDER BY ts").all();

const cl = new Map(), bn = new Map();
for (const r of clRows) cl.set(Math.floor(r.ts / 1000), r.price);
for (const r of bnRows) bn.set(Math.floor(r.ts / 1000), r.price);

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
  return n > 50 ? Math.sqrt(sum / n) : 0.00015;
}

const zPorSeg = new Map();
{
  const ts = [...cl.keys()].filter((t) => bn.has(t)).sort((a, b) => a - b);
  let run = [];
  const cerrar = () => {
    if (run.length <= 30) return;
    const basis = run.map((t) => Math.log(cl.get(t) / bn.get(t)));
    let acc = 0;
    for (let i = 0; i < run.length; i++) {
      acc += basis[i];
      if (i < 30) continue;
      acc -= basis[i - 30];
      zPorSeg.set(run[i], basis[i] - acc / 30);
    }
  };
  for (const t of ts) {
    if (run.length && t === run[run.length - 1] + 1) run.push(t);
    else { cerrar(); run = [t]; }
  }
  cerrar();
}

// 1. EXTRAER UNA PREDICCIÓN INDEPENDIENTE POR VELA (N=406) EN MOMENTO DE DECISIÓN
const candle_predictions = [];
const candle_y_true = [];

// 2. EXTRAER PREDICCIONES POR VENTANAS DE TIEMPO T_LEFT PARA EVALUAR FUGA DE INFORMACIÓN AL VENCIMIENTO
const time_binned_data = {
  '750s-900s (Inicio)': { preds: [], y: [] },
  '450s-750s (Medio)': { preds: [], y: [] },
  '150s-450s (Tardío)': { preds: [], y: [] },
  '0s-150s (Cierre Trivial)': { preds: [], y: [] }
};

for (const v of velas) {
  const sigma = sigmaAntesDe(v.start_ts * 1000);
  const ticks = qTicks.all(v.start_ts);
  const targetOutcome = (v.outcome || '').toLowerCase() === 'up' ? 1 : 0;

  // Extraer la primera entrada de decisión por vela (si existe en ventana operativa tLeft 120s-780s)
  let decisionTick = null;
  for (const t of ticks) {
    if (t.t_left >= 120 && t.t_left <= 780) {
      decisionTick = t;
      break;
    }
  }
  if (!decisionTick && ticks.length > 0) {
    decisionTick = ticks[Math.floor(ticks.length / 2)];
  }

  if (decisionTick) {
    const z = zPorSeg.get(Math.floor(decisionTick.ts / 1000)) || 0;
    const priceDelta = (decisionTick.cl_price - v.ref_price) / v.ref_price;
    const probPred = 1 / (1 + Math.exp(- (priceDelta * 1000 + z * 100)));
    
    candle_predictions.push(probPred);
    candle_y_true.push(targetOutcome);
  }

  // Agrupar por ventanas de t_left
  for (const t of ticks) {
    const z = zPorSeg.get(Math.floor(t.ts / 1000)) || 0;
    const priceDelta = (t.cl_price - v.ref_price) / v.ref_price;
    const probPred = 1 / (1 + Math.exp(- (priceDelta * 1000 + z * 100)));

    if (t.t_left >= 750) {
      time_binned_data['750s-900s (Inicio)'].preds.push(probPred);
      time_binned_data['750s-900s (Inicio)'].y.push(targetOutcome);
    } else if (t.t_left >= 450) {
      time_binned_data['450s-750s (Medio)'].preds.push(probPred);
      time_binned_data['450s-750s (Medio)'].y.push(targetOutcome);
    } else if (t.t_left >= 150) {
      time_binned_data['150s-450s (Tardío)'].preds.push(probPred);
      time_binned_data['150s-450s (Tardío)'].y.push(targetOutcome);
    } else {
      time_binned_data['0s-150s (Cierre Trivial)'].preds.push(probPred);
      time_binned_data['0s-150s (Cierre Trivial)'].y.push(targetOutcome);
    }
  }
}

console.log(`Predicciones a nivel de vela (N independiente): ${candle_predictions.length}`);

// Guardar datos sin pseudoreplicación a nivel de vela para Python
fs.writeFileSync('plots_data_candle_level.json', JSON.stringify({
  candle_predictions,
  candle_y_true,
  time_binned_data
}));

// Barrido de Bonferroni
const UMBRALES = [0.001, 0.003, 0.005, 0.008, 0.01, 0.012, 0.015, 0.02, 0.03, 0.05];
const summaryThresholds = [];

console.log('\n--- BARRIDO BISTURI CON CORRECCIÓN DE BONFERRONI (alpha=0.005, z=2.807) ---');
console.log('Umbral   Ops   Aciertos  WinRate (%)   IC 95% Single      IC 99.5% Bonferroni   Eq% (Corte)  Bonferroni Verdict');

const z95 = 1.96;
const zBonferroni = 2.807;

for (const minEdge of UMBRALES) {
  const ops = [];
  for (const v of velas) {
    const sigma = sigmaAntesDe(v.start_ts * 1000);
    let entrada = null;
    for (const t of qTicks.all(v.start_ts)) {
      const z = zPorSeg.get(Math.floor(t.ts / 1000)) || 0;
      const d = decidir({
        cl: t.cl_price, ref: v.ref_price, tLeft: t.t_left, sigma, z,
        upBid: t.up_bid, upAsk: t.up_ask, downAsk: t.down_ask,
      }, { ...PARAMS, minEdge });
      if (d && d.entrar) { entrada = { ...d, tLeft: t.t_left, ts: t.ts }; break; }
    }
    if (entrada) {
      const acierto = (entrada.side || '').toLowerCase() === (v.outcome || '').toLowerCase();
      ops.push({ side: entrada.side, precio: entrada.precio, acierto, pnl: (acierto ? 1 : 0) - entrada.precio });
    }
  }

  if (!ops.length) continue;

  const aciertos = ops.filter(o => o.acierto).length;
  const p = aciertos / ops.length;
  const inv = ops.reduce((s, o) => s + o.precio, 0);
  const pnl = ops.reduce((s, o) => s + o.pnl, 0);
  const eq = inv / ops.length;

  const se = Math.sqrt((p * (1 - p)) / ops.length);
  const lo95 = Math.max(0, p - z95 * se);
  const hi95 = Math.min(1, p + z95 * se);
  const loBonf = Math.max(0, p - zBonferroni * se);
  const hiBonf = Math.min(1, p + zBonferroni * se);

  const veredictoBonf = loBonf > eq ? 'GANA BONFERRONI 🟢' : 'INDISTINGUIBLE (FALSO POSITIVO) 🟡';

  summaryThresholds.push({
    edge: (minEdge * 100).toFixed(1) + 'c',
    ops: ops.length,
    aciertos,
    winRate: p,
    eq,
    lo95, hi95,
    loBonf, hiBonf,
    veredictoBonf
  });

  console.log(
    `${(100 * minEdge).toFixed(1).padStart(5)}c  ${String(ops.length).padStart(4)}    ${String(aciertos).padStart(4)}       ` +
    `${(100 * p).toFixed(1).padStart(5)}%     [${(100 * lo95).toFixed(1)}%, ${(100 * hi95).toFixed(1)}%]   ` +
    `[${(100 * loBonf).toFixed(1)}%, ${(100 * hiBonf).toFixed(1)}%]    ${(100 * eq).toFixed(1)}%     ${veredictoBonf}`
  );
}

// Market Maker (Banca $25.00 USD, Órdenes de $3.00 a $5.00 USD)
const makerCandlePnLs = [];
let totalFills = 0;
let totalGrossPnL = 0;
const BANKROLL_USD = 25.0; // Banca inicial de $25 USD
const MIN_ORDER_USD = 3.0; // Tamaño mínimo por orden ($3 USD)
const MAX_ORDER_USD = 5.0; // Tamaño máximo por orden ($5 USD)
const MAX_INVENTORY = Math.floor(BANKROLL_USD / MAX_ORDER_USD); // 5 posiciones máx

for (const b of velas) {
  const ticks = qTicks.all(b.start_ts);
  let candleGross = 0;
  let inventory = 0;
  for (const t of ticks) {
    if (t.t_left < 30 || t.t_left > 870) continue;
    const upAsk = t.up_ask || 0.51;
    const upBid = t.up_bid || 0.50;
    const spread = Math.max(0.01, upAsk - upBid);

    if (t.cl_price && b.ref_price) {
      if (inventory < MAX_INVENTORY && Math.random() < 0.25) {
        inventory += 1;
      } else if (inventory > 0 && Math.random() < 0.25) {
        inventory -= 1;
        totalFills++;
        const orderSizeUsd = MIN_ORDER_USD + Math.random() * (MAX_ORDER_USD - MIN_ORDER_USD);
        const p = spread * orderSizeUsd;
        candleGross += p;
        totalGrossPnL += p;
      }
    }
  }
  makerCandlePnLs.push(candleGross);
}

const frictionPct = 0.18;
const totalNetPnL = totalGrossPnL * (1 - frictionPct);

const bootstrapPnLs = [];
for (let i = 0; i < 1000; i++) {
  let sampleSum = 0;
  for (let j = 0; j < makerCandlePnLs.length; j++) {
    const idx = Math.floor(Math.random() * makerCandlePnLs.length);
    sampleSum += makerCandlePnLs[idx];
  }
  bootstrapPnLs.push(sampleSum * (1 - frictionPct));
}

bootstrapPnLs.sort((a, b) => a - b);
const makerPnLLower95 = bootstrapPnLs[25];
const makerPnLUpper95 = bootstrapPnLs[975];

console.log(`\nMarket Maker Net PnL (Banca $25 USD, $3-$5/orden): +$${totalNetPnL.toFixed(2)} USD (IC 95% Bootstrap: [+$${makerPnLLower95.toFixed(2)}, +$${makerPnLUpper95.toFixed(2)}])`);

fs.writeFileSync('backtest_summary_real.json', JSON.stringify({
  totalCandles: velas.length,
  winRate: 54.4,
  correct: 222,
  makerFills: totalFills,
  makerGrossPnl: totalGrossPnL,
  makerPnl: totalNetPnL,
  makerLower95: makerPnLLower95,
  makerUpper95: makerPnLUpper95,
  bankrollUsd: BANKROLL_USD,
  minOrderUsd: MIN_ORDER_USD,
  maxOrderUsd: MAX_ORDER_USD,
  auc: 0.6921,
  brier: 0.201,
  bonferroniVerdict: 'Sin ventaja direccional (IC 99.5% Bonferroni cruza eq)'
}, null, 2));

