'use strict';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const BUCKET = 900; // 15 min

function bucketStart(tsSec = Math.floor(Date.now() / 1000)) {
  return tsSec - (tsSec % BUCKET);
}

function slugFor(startTs) {
  return `btc-updown-15m-${startTs}`;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Devuelve el mercado normalizado, o null si Polymarket aún no lo creó.
async function fetchMarket(startTs) {
  const rows = await getJson(`${GAMMA}/markets?slug=${slugFor(startTs)}`);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return normalize(rows[0], startTs);
}

function normalize(m, startTs) {
  const outcomes = JSON.parse(m.outcomes);
  const tokens = JSON.parse(m.clobTokenIds);
  const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : null;
  const upIdx = outcomes.indexOf('Up');
  const downIdx = outcomes.indexOf('Down');
  return {
    slug: m.slug,
    startTs,
    endTs: startTs + BUCKET,
    question: m.question,
    conditionId: m.conditionId,
    upToken: tokens[upIdx],
    downToken: tokens[downIdx],
    upPrice: prices ? Number(prices[upIdx]) : null,
    downPrice: prices ? Number(prices[downIdx]) : null,
    tickSize: m.orderPriceMinTickSize,
    minOrderSize: m.orderMinSize,
    makerFeeBps: m.makerBaseFee,
    takerFeeBps: m.takerBaseFee,
    liquidity: m.liquidityNum ?? null,
    closed: m.closed,
    acceptingOrders: m.acceptingOrders,
  };
}

// Libro completo de un token. Devuelve niveles ordenados de mejor a peor.
async function fetchBook(tokenId) {
  const b = await getJson(`${CLOB}/book?token_id=${tokenId}`);
  const bids = (b.bids || [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .sort((x, y) => y.price - x.price);
  const asks = (b.asks || [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .sort((x, y) => x.price - y.price);
  return { tokenId, ts: Number(b.timestamp), bids, asks };
}

// Precio promedio de ejecución al comprar `usd` dólares contra el lado ask.
function sweepCost(asks, usd) {
  let spent = 0;
  let shares = 0;
  for (const lvl of asks) {
    const avail = lvl.price * lvl.size;
    const take = Math.min(avail, usd - spent);
    if (take <= 0) break;
    spent += take;
    shares += take / lvl.price;
    if (spent >= usd - 1e-9) break;
  }
  if (shares === 0) return null;
  return { filledUsd: spent, shares, avgPrice: spent / shares, complete: spent >= usd - 1e-9 };
}

module.exports = { BUCKET, bucketStart, slugFor, fetchMarket, fetchBook, sweepCost, GAMMA, CLOB };
