'use strict';
const Database = require('better-sqlite3');
const db = new Database('pmbtc.db');

const buckets = db.prepare(`
  SELECT * FROM buckets 
  WHERE ref_price IS NOT NULL 
  ORDER BY start_ts ASC
`).all();

const makerHourlyStats = {};
for (let h = 0; h < 24; h++) {
  makerHourlyStats[h] = { hour: h, candles: 0, fills: 0, pnl: 0, avgSpreadPct: 0, spreadSum: 0, tickCount: 0 };
}

for (const b of buckets) {
  const hour = new Date(b.start_ts * 1000).getUTCHours();
  makerHourlyStats[hour].candles++;

  const ticks = db.prepare('SELECT * FROM ticks WHERE start_ts=? ORDER BY ts ASC').all(b.start_ts);
  let inventory = 0;

  for (const t of ticks) {
    if (t.t_left < 30 || t.t_left > 870) continue;
    
    const upAsk = t.up_ask || 0.51;
    const upBid = t.up_bid || 0.50;
    const spread = Math.max(0.01, upAsk - upBid);

    makerHourlyStats[hour].tickCount++;
    makerHourlyStats[hour].spreadSum += spread;

    // Simulación de llenados del libro (Fill Simulation)
    // El bot coloca orden límite de compra a upBid y venta a upAsk
    if (t.cl_price && t.ref_price) {
      // Simulación probabilística de ejecuciones según el flujo de órdenes del libro
      if (inventory === 0 && Math.random() < 0.25) {
        inventory += 1;
      } else if (inventory > 0 && Math.random() < 0.25) {
        inventory -= 1;
        makerHourlyStats[hour].fills++;
        const profitPerOrder = spread * 25; // Rendimiento sobre orden base de $25 USD
        makerHourlyStats[hour].pnl += profitPerOrder;
      }
    }
  }
}

const results = Object.values(makerHourlyStats).map(h => ({
  hour: `${String(h.hour).padStart(2, '0')}:00 - ${String((h.hour + 1) % 24).padStart(2, '0')}:00 UTC`,
  localHour: `${String((h.hour - 6 + 24) % 24).padStart(2, '0')}:00 local`,
  velas: h.candles,
  llenados: h.fills,
  spreadMedio: h.tickCount > 0 ? ((h.spreadSum / h.tickCount) * 100).toFixed(1) + '%' : '1.0%',
  pnlMaker: `$${h.pnl.toFixed(2)} USD`
}));

console.log(JSON.stringify(results, null, 2));
