'use strict';

// Resolución del precio de chainlink en un instante de corte.
//
// El feed publica ~1 tick/s, así que lo normal es que exista un tick con el
// timestamp exacto del corte. Cuando falta (hueco del feed), se acepta el más
// cercano dentro de la tolerancia, pero se registra el desfase: chainlink se
// mueve ~1-3 USD/s y la sigma de una vela de 15 min ronda los 60 USD, así que
// un tick a 3s puede valer un 5-15% de sigma. Eso no se puede tratar igual que
// un dato exacto y por eso el desfase se guarda en la DB.

const DEFAULT_TOLERANCE_MS = 15000;

function resolvePrice(db, tsMs, toleranceMs = DEFAULT_TOLERANCE_MS) {
  const exact = db
    .prepare("SELECT ts, price FROM underlying WHERE source='chainlink' AND ts = ?")
    .get(tsMs);
  if (exact) return { price: exact.price, ts: exact.ts, offsetMs: 0, source: 'feed' };

  // Se prefiere hacia adelante: el mercado resuelve con el reporte en o
  // inmediatamente después del corte, no con el anterior.
  const after = db
    .prepare("SELECT ts, price FROM underlying WHERE source='chainlink' AND ts > ? AND ts <= ? ORDER BY ts LIMIT 1")
    .get(tsMs, tsMs + toleranceMs);
  const before = db
    .prepare("SELECT ts, price FROM underlying WHERE source='chainlink' AND ts < ? AND ts >= ? ORDER BY ts DESC LIMIT 1")
    .get(tsMs, tsMs - toleranceMs);

  let pick = null;
  if (after && before) pick = after.ts - tsMs <= tsMs - before.ts ? after : before;
  else pick = after || before;
  if (!pick) return null;

  return { price: pick.price, ts: pick.ts, offsetMs: pick.ts - tsMs, source: 'feed' };
}

// Ticks que rodean el corte. Cuando hay hueco, el valor real de la frontera está
// entre ambos, y esa horquilla puede ser de decenas de USD: sirve para comprobar
// si un outcome se sostiene o si el hueco lo deja indeterminado.
function priceBounds(db, tsMs, toleranceMs = DEFAULT_TOLERANCE_MS) {
  const before = db
    .prepare("SELECT ts, price FROM underlying WHERE source='chainlink' AND ts <= ? AND ts >= ? ORDER BY ts DESC LIMIT 1")
    .get(tsMs, tsMs - toleranceMs);
  const after = db
    .prepare("SELECT ts, price FROM underlying WHERE source='chainlink' AND ts >= ? AND ts <= ? ORDER BY ts LIMIT 1")
    .get(tsMs, tsMs + toleranceMs);
  const cands = [before, after].filter(Boolean).map((r) => r.price);
  if (!cands.length) return null;
  return { lo: Math.min(...cands), hi: Math.max(...cands) };
}

module.exports = { resolvePrice, priceBounds, DEFAULT_TOLERANCE_MS };
