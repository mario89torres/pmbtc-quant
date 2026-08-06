'use strict';
const Database = require('better-sqlite3');
const db = new Database('pmbtc.db');

const buckets = db.prepare(`
  SELECT * FROM buckets 
  WHERE outcome IS NOT NULL AND ref_price IS NOT NULL AND final_price IS NOT NULL 
  ORDER BY start_ts ASC
`).all();

const hourlyStats = {};
for (let h = 0; h < 24; h++) {
  hourlyStats[h] = { hour: h, count: 0, win: 0, pnl: 0 };
}

for (const b of buckets) {
  const t = db.prepare('SELECT * FROM ticks WHERE start_ts=? AND t_left >= 300 AND t_left <= 600 ORDER BY ts DESC LIMIT 1').get(b.start_ts);
  if (!t) continue;

  const hour = new Date(b.start_ts * 1000).getUTCHours();
  const cl = t.cl_price;
  const ref = b.ref_price;
  const predUp = cl >= ref;
  const actualUp = b.outcome === 'Up';
  const isWin = predUp === actualUp;

  hourlyStats[hour].count++;
  if (isWin) {
    hourlyStats[hour].win++;
    hourlyStats[hour].pnl += 25 * 0.85;
  } else {
    hourlyStats[hour].pnl -= 25;
  }
}

const results = Object.values(hourlyStats).map(h => ({
  hour: `${String(h.hour).padStart(2, '0')}:00 - ${String((h.hour + 1) % 24).padStart(2, '0')}:00 UTC`,
  localHour: `${String((h.hour - 6 + 24) % 24).padStart(2, '0')}:00 local`,
  velas: h.count,
  aciertos: h.win,
  winRate: h.count > 0 ? ((h.win / h.count) * 100).toFixed(1) + '%' : '0%',
  pnl: `$${h.pnl.toFixed(2)} USD`
}));

console.log(JSON.stringify(results, null, 2));
