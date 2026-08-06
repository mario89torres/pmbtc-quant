'use strict';

// Colector de data del mercado "Bitcoin Up or Down - 15m" de Polymarket.
// No opera: solo graba libro + subyacente tick a tick para poder medir si
// existe edge antes de escribir cualquier lógica de apuesta.
//
//   node pmbtc/collect.js            -> corre indefinidamente
//   node pmbtc/collect.js --buckets 4 -> se detiene tras 4 buckets completos

const { open } = require('./src/db');
const { PriceFeed } = require('./src/feed');
const { BUCKET, bucketStart, fetchMarket, fetchBook } = require('./src/gamma');
const { resolvePrice, priceBounds } = require('./src/prices');

const SAMPLE_MS = Number(process.env.PMBTC_SAMPLE_MS || 2000);
const args = process.argv.slice(2);
const maxBuckets = args.includes('--buckets') ? Number(args[args.indexOf('--buckets') + 1]) : Infinity;

const db = open();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Última red: un fallo de red transitorio no debe costar la vela en curso.
// Se registra ruidosamente porque cada aviso aquí es un sitio sin try/catch que
// habría que arreglar, no algo que deba normalizarse.
process.on('unhandledRejection', (e) => {
  log('RECHAZO NO CAPTURADO (el colector sigue vivo):', e && e.message ? e.message : e);
});

const insUnderlying = db.prepare(
  'INSERT OR IGNORE INTO underlying (source, ts, price) VALUES (?, ?, ?)'
);
const insBucket = db.prepare(`
  INSERT INTO buckets (start_ts, slug, question, condition_id, up_token, down_token, created_at)
  VALUES (@startTs, @slug, @question, @conditionId, @upToken, @downToken, @createdAt)
  ON CONFLICT (start_ts) DO UPDATE SET
    slug=excluded.slug, question=excluded.question, condition_id=excluded.condition_id,
    up_token=excluded.up_token, down_token=excluded.down_token
`);
const insTick = db.prepare(`
  INSERT OR IGNORE INTO ticks (
    start_ts, ts, t_left, cl_price, cl_ts, bn_price, bn_ts, ref_price,
    up_bid, up_bid_sz, up_ask, up_ask_sz, down_bid, down_bid_sz, down_ask, down_ask_sz,
    up_depth_usd, dn_depth_usd
  ) VALUES (
    @startTs, @ts, @tLeft, @clPrice, @clTs, @bnPrice, @bnTs, @refPrice,
    @upBid, @upBidSz, @upAsk, @upAskSz, @downBid, @downBidSz, @downAsk, @downAskSz,
    @upDepthUsd, @dnDepthUsd
  )
`);

// El tick del corte llega ~1.5s tarde y se escribe en el flush siguiente, y a
// veces el feed se salta un segundo justo ahí. Se reintenta en vez de consultar
// una sola vez, que es lo que hacía perder cortes perfectamente recuperables.
async function resolveAt(tsMs, { attempts = 12, everyMs = 2500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const exact = resolvePrice(db, tsMs, 0);
    if (exact) return exact;
    await sleep(everyMs);
  }
  // Agotados los reintentos se acepta el vecino más cercano, con su desfase.
  return resolvePrice(db, tsMs);
}

// ---- feed del subyacente -----------------------------------------------------

let pending = [];
const feed = new PriceFeed({
  log,
  onTick: (t) => pending.push([t.source, t.ts, t.price]),
});
const flush = db.transaction((rows) => {
  for (const r of rows) insUnderlying.run(r);
});
setInterval(() => {
  if (!pending.length) return;
  const rows = pending;
  pending = [];
  flush(rows);
}, 1000).unref();
feed.start();

// ---- muestreo del libro ------------------------------------------------------

function top(levels) {
  return levels.length ? levels[0] : { price: null, size: null };
}
function depthUsd(asks) {
  return asks.reduce((s, l) => s + l.price * l.size, 0);
}

async function sampleOnce(market, refPrice) {
  const [upBook, dnBook] = await Promise.all([
    fetchBook(market.upToken),
    fetchBook(market.downToken),
  ]);
  const cl = feed.last.chainlink;
  const bn = feed.last.binance;
  const now = Date.now();
  const ub = top(upBook.bids);
  const ua = top(upBook.asks);
  const dbid = top(dnBook.bids);
  const dask = top(dnBook.asks);

  insTick.run({
    startTs: market.startTs,
    ts: now,
    tLeft: market.endTs - now / 1000,
    clPrice: cl ? cl.price : null,
    clTs: cl ? cl.ts : null,
    bnPrice: bn ? bn.price : null,
    bnTs: bn ? bn.ts : null,
    refPrice: refPrice ?? null,
    upBid: ub.price, upBidSz: ub.size, upAsk: ua.price, upAskSz: ua.size,
    downBid: dbid.price, downBidSz: dbid.size, downAsk: dask.price, downAskSz: dask.size,
    upDepthUsd: depthUsd(upBook.asks),
    dnDepthUsd: depthUsd(dnBook.asks),
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Contrasta el outcome calculado en local contra la resolución real de Polymarket.
// Se reintenta: a los 2 min el mercado suele seguir sin resolver y `outcomePrices`
// todavía es el precio de mercado (0.46, 0.58...), no un settlement. Guardar eso
// como si fuera la resolución contamina la única fuente de verdad que tenemos.
async function verifySettlement(startTs) {
  const delays = [120, 300, 600, 1200, 2400]; // segundos
  for (const d of delays) {
    await sleep(d * 1000);
    let m;
    try {
      m = await fetchMarket(startTs);
    } catch (e) {
      log(`[bucket ${startTs}] verificación falló: ${e.message}`);
      continue;
    }
    if (!m || m.upPrice == null) continue;
    // Solo es settlement si el mercado cerró y el precio es concluyente.
    const decisive = m.upPrice >= 0.99 ? 'Up' : m.upPrice <= 0.01 ? 'Down' : null;
    if (!m.closed || !decisive) continue;

    db.prepare('UPDATE buckets SET settled_up=? WHERE start_ts=?').run(m.upPrice, startTs);
    const row = db.prepare('SELECT outcome FROM buckets WHERE start_ts=?').get(startTs);
    const mine = row && row.outcome;
    if (!mine) {
      log(`[bucket ${startTs}] gamma resolvió ${decisive}; en local no había outcome`);
    } else if (mine !== decisive) {
      log(`[bucket ${startTs}] DISCREPANCIA: local ${mine}, gamma ${decisive}`);
    } else {
      log(`[bucket ${startTs}] verificado OK contra gamma (${decisive})`);
    }
    return;
  }
  log(`[bucket ${startTs}] gamma no resolvió tras 45 min; sin verificar`);
}

async function runBucket(startTs) {
  const endTs = startTs + BUCKET;

  // Un parpadeo de DNS no puede tumbar el colector: se reintenta unas veces
  // antes de dar la vela por perdida.
  let market = null;
  for (let i = 0; i < 3 && !market; i++) {
    try {
      market = await fetchMarket(startTs);
    } catch (e) {
      log(`[bucket ${startTs}] gamma falló (intento ${i + 1}/3): ${e.message}`);
      if (i < 2) await sleep(3000);
    }
  }
  if (!market) {
    log(`[bucket ${startTs}] sin mercado en gamma, salto`);
    await sleep(Math.max(0, endTs * 1000 - Date.now()) + 500);
    return null;
  }
  insBucket.run({ ...market, createdAt: Math.floor(Date.now() / 1000) });
  log(`[bucket ${startTs}] ${market.question} | liq ${market.liquidity}`);

  // El tick de chainlink del corte llega ~1.5s tarde y se escribe en el flush
  // siguiente, así que no se puede leer la ref en el instante del corte: hay que
  // resolverla en diferido y rellenar hacia atrás los ticks ya grabados. El
  // muestreo arranca ya, porque los primeros segundos son los más informativos.
  let refPrice = null;
  resolveAt(startTs * 1000).then((ref) => {
    if (!ref) {
      log(`[bucket ${startTs}] sin ref (feed caído en el corte); solo se graban ticks`);
      return;
    }
    refPrice = ref.price;
    db.prepare(
      'UPDATE buckets SET ref_price=?, ref_ts=?, ref_offset_ms=?, ref_source=? WHERE start_ts=?'
    ).run(ref.price, ref.ts, ref.offsetMs, ref.source, startTs);
    db.prepare('UPDATE ticks SET ref_price = ? WHERE start_ts = ? AND ref_price IS NULL')
      .run(ref.price, startTs);
    log(`[bucket ${startTs}] ref chainlink = ${ref.price.toFixed(2)}` +
        (ref.offsetMs ? ` (aprox, ${ref.offsetMs >= 0 ? '+' : ''}${ref.offsetMs}ms)` : ''));
  }).catch((e) => log(`[bucket ${startTs}] ref falló:`, e.message));

  let n = 0;
  while (Date.now() / 1000 < endTs) {
    const t0 = Date.now();
    try {
      await sampleOnce(market, refPrice);
      n++;
    } catch (e) {
      log(`[bucket ${startTs}] fallo al muestrear:`, e.message);
    }
    await sleep(Math.max(0, SAMPLE_MS - (Date.now() - t0)));
  }

  // El cierre se resuelve en segundo plano: la vela siguiente empieza en este
  // mismo instante, así que esperar aquí le robaría sus primeras muestras.
  finalize(startTs, endTs, n).catch((e) => log(`[bucket ${startTs}] cierre abortado:`, e.message));
}

async function finalize(startTs, endTs, n) {
  const fin = await resolveAt(endTs * 1000);
  if (!fin) {
    log(`[bucket ${startTs}] sin cierre (feed caído en el corte) | ${n} ticks`);
    return;
  }

  // El cierre se guarda aunque falte la ref: es un dato válido por sí mismo y,
  // además, es la referencia de la vela siguiente.
  db.prepare(
    'UPDATE buckets SET final_price=?, final_ts=?, final_offset_ms=?, final_source=? WHERE start_ts=?'
  ).run(fin.price, fin.ts, fin.offsetMs, fin.source, startTs);

  const row = db.prepare('SELECT ref_price, ref_offset_ms FROM buckets WHERE start_ts=?').get(startTs);
  const ref = row && row.ref_price;
  if (ref == null) {
    log(`[bucket ${startTs}] cierre ${fin.price.toFixed(2)} guardado, pero sin ref: outcome indeterminado | ${n} ticks`);
    return;
  }

  const outcome = fin.price >= ref ? 'Up' : 'Down';
  const move = fin.price - ref;

  // Con extremos aproximados, el hueco del feed puede bastar para voltear el
  // resultado. En ese caso no se afirma outcome.
  if (row.ref_offset_ms || fin.offsetMs) {
    const rb = priceBounds(db, startTs * 1000);
    const fb = priceBounds(db, endTs * 1000);
    const peor = rb && fb ? (fb.lo >= rb.hi ? 'Up' : fb.hi < rb.lo ? 'Down' : null) : null;
    if (peor !== outcome) {
      log(`[bucket ${startTs}] outcome indeterminado: el hueco del feed puede voltearlo | ${n} ticks`);
      return;
    }
  }

  db.prepare('UPDATE buckets SET outcome=? WHERE start_ts=?').run(outcome, startTs);
  log(`[bucket ${startTs}] cierre ${fin.price.toFixed(2)} (${move >= 0 ? '+' : ''}${move.toFixed(2)}) -> ${outcome} | ${n} ticks`);

  verifySettlement(startTs).catch((e) => log(`[bucket ${startTs}] verificación abortada:`, e.message));
}

(async () => {
  log(`colector iniciado | muestreo ${SAMPLE_MS}ms | db ${require('./src/db').DB_PATH}`);
  let done = 0;
  // Arranca en el bucket siguiente si el actual ya va muy avanzado: sin ref
  // el bucket no sirve para evaluar edge.
  let cur = bucketStart();
  const elapsed = Date.now() / 1000 - cur;
  if (elapsed > 5) {
    log(`bucket actual lleva ${elapsed.toFixed(0)}s, espero el siguiente para tener ref limpio`);
    cur += BUCKET;
    await sleep(cur * 1000 - Date.now());
  }
  while (done < maxBuckets) {
    await runBucket(cur);
    done++;
    cur += BUCKET;
    const wait = cur * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    else cur = bucketStart();
  }
  feed.stop();
  log('colector detenido');
  process.exit(0);
})();
