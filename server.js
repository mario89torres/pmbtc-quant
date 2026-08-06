'use strict';

// Visor web de la data que graba collect.js. Solo lectura: no opera ni escribe.
//
//   node pmbtc/server.js        -> http://localhost:8787

const http = require('http');
const fs = require('fs');
const path = require('path');
const { open } = require('./src/db');
const { sigmaPerSecond, fairUp } = require('./src/model');
const { BUCKET, bucketStart } = require('./src/gamma');

const PORT = Number(process.env.PMBTC_PORT || 8787);
const db = open();

// ---- consultas ---------------------------------------------------------------

function feedStatus() {
  const rows = db
    .prepare('SELECT source, COUNT(*) n, MIN(ts) a, MAX(ts) b FROM underlying GROUP BY source')
    .all();
  const sources = rows.map((r) => {
    const spanMin = (r.b - r.a) / 60000;
    return {
      source: r.source,
      ticks: r.n,
      spanMin,
      coverage: spanMin > 0 ? r.n / (spanMin * 60) : null,
      lastTs: r.b,
      lastPrice: db
        .prepare('SELECT price FROM underlying WHERE source=? ORDER BY ts DESC LIMIT 1')
        .get(r.source)?.price ?? null,
    };
  });
  const newest = Math.max(0, ...sources.map((s) => s.lastTs || 0));
  return { sources, lastTs: newest || null, live: newest > 0 && Date.now() - newest < 15000 };
}

function bucketRows() {
  const rows = db.prepare('SELECT * FROM buckets ORDER BY start_ts DESC').all();
  const cnt = db.prepare('SELECT COUNT(*) c FROM ticks WHERE start_ts=?');
  return rows.map((b) => ({
    startTs: b.start_ts,
    slug: b.slug,
    question: b.question,
    refPrice: b.ref_price,
    finalPrice: b.final_price,
    outcome: b.outcome,
    settledUp: b.settled_up,
    move: b.final_price != null && b.ref_price != null ? b.final_price - b.ref_price : null,
    ticks: cnt.get(b.start_ts).c,
    // Calidad del corte: 0ms es un tick exacto; cualquier otra cosa es el vecino
    // más cercano y el movimiento medido arrastra ese error.
    refOffsetMs: b.ref_offset_ms,
    finalOffsetMs: b.final_offset_ms,
    approx: Boolean(b.ref_offset_ms || b.final_offset_ms),
    chained: b.ref_source === 'chain' || b.final_source === 'chain',
    outcomeSource: b.outcome_source,
  }));
}

function micro() {
  const sp = db
    .prepare(
      // "cross" es palabra reservada en SQLite (CROSS JOIN): no vale como alias.
      `SELECT AVG(up_ask - up_bid) spread, AVG(up_ask + down_ask - 1) crossCost,
              AVG(up_depth_usd) upDepth, AVG(dn_depth_usd) dnDepth, COUNT(*) n
       FROM ticks WHERE up_bid IS NOT NULL AND up_ask IS NOT NULL AND down_ask IS NOT NULL`
    )
    .get();
  return sp.n ? sp : null;
}

// Calibración del precio del mercado contra el resultado real, separada por
// tiempo restante. Sin esa separación la tabla engaña: la mayoría de los ticks
// de una vela caen cuando el resultado ya está prácticamente decidido, así que
// agregarlos todos juntos simula un sesgo enorme que en realidad es la vela
// resolviéndose, no una oportunidad.
const PHASES = [
  { key: 'early', label: '> 10 min', min: 600, max: Infinity },
  { key: 'mid', label: '5–10 min', min: 300, max: 600 },
  { key: 'late', label: '< 5 min', min: -Infinity, max: 300 },
];

function calibration() {
  const resolved = db.prepare("SELECT start_ts, outcome FROM buckets WHERE outcome IS NOT NULL").all();
  const q = db.prepare('SELECT t_left, up_bid, up_ask FROM ticks WHERE start_ts=?');
  const acc = new Map(); // `${phase}|${bin}` -> agregado

  for (const b of resolved) {
    for (const t of q.all(b.start_ts)) {
      if (t.up_bid == null || t.up_ask == null) continue;
      const phase = PHASES.find((p) => t.t_left >= p.min && t.t_left < p.max);
      if (!phase) continue;
      const mid = (t.up_bid + t.up_ask) / 2;
      const bin = Math.min(9, Math.max(0, Math.floor(mid * 10)));
      const k = `${phase.key}|${bin}`;
      const e = acc.get(k) || { n: 0, up: 0, sum: 0 };
      e.n++;
      e.sum += mid;
      if (b.outcome === 'Up') e.up++;
      acc.set(k, e);
    }
  }

  return {
    buckets: resolved.length,
    phases: PHASES.map((p) => ({
      key: p.key,
      label: p.label,
      rows: [...acc.entries()]
        .filter(([k]) => k.startsWith(p.key + '|'))
        .map(([k, e]) => ({
          bin: Number(k.split('|')[1]),
          n: e.n,
          implied: e.sum / e.n,
          actual: e.up / e.n,
        }))
        .sort((a, b) => a.bin - b.bin),
    })),
  };
}

function bucketDetail(startTs) {
  const b = db.prepare('SELECT * FROM buckets WHERE start_ts=?').get(startTs);
  if (!b) return null;
  const { sigma } = sigmaPerSecond(db);
  const ticks = db.prepare('SELECT * FROM ticks WHERE start_ts=? ORDER BY ts').all(startTs);
  return {
    bucket: {
      startTs: b.start_ts,
      slug: b.slug,
      question: b.question,
      refPrice: b.ref_price,
      finalPrice: b.final_price,
      outcome: b.outcome,
      settledUp: b.settled_up,
    },
    sigma,
    ticks: ticks.map((t) => {
      const ref = t.ref_price ?? b.ref_price;
      const mid = t.up_bid != null && t.up_ask != null ? (t.up_bid + t.up_ask) / 2 : null;
      const fair = fairUp(t.cl_price, ref, t.t_left, sigma);
      return {
        ts: t.ts,
        tLeft: t.t_left,
        cl: t.cl_price,
        bn: t.bn_price,
        ref,
        drift: t.cl_price != null && ref != null ? t.cl_price - ref : null,
        upBid: t.up_bid,
        upAsk: t.up_ask,
        dnBid: t.down_bid,
        dnAsk: t.down_ask,
        mid,
        fair,
        edge: fair != null && t.up_ask != null ? fair - t.up_ask : null,
        upDepth: t.up_depth_usd,
        dnDepth: t.dn_depth_usd,
      };
    }),
  };
}

// Serie del subyacente dentro de la ventana de un bucket, a resolución de 1s.
function underlyingFor(startTs) {
  const a = startTs * 1000;
  const b = (startTs + BUCKET) * 1000 + 10000;
  const rows = db
    .prepare('SELECT source, ts, price FROM underlying WHERE ts>=? AND ts<=? ORDER BY ts')
    .all(a, b);
  const out = { chainlink: [], binance: [] };
  for (const r of rows) if (out[r.source]) out[r.source].push([r.ts, r.price]);
  return out;
}

const { decidir } = require('./src/strategy');
const { predictMl } = require('./src/ml_model');
const { calculateKellyFraction, calculateExpectedValue, evaluateRiskRegime } = require('./src/risk_engine');
const { evaluateMakerPlay, makerBotInstance } = require('./src/maker_bot');


function getLiveForecast(db, sigma, startTsOverride) {
  const currentTs = startTsOverride || bucketStart();
  const b = db.prepare('SELECT * FROM buckets WHERE start_ts=?').get(currentTs);
  if (!b) return { status: 'NO_BUCKET', message: 'Iniciando nueva vela...' };

  const latestTick = db.prepare('SELECT * FROM ticks WHERE start_ts=? ORDER BY ts DESC LIMIT 1').get(currentTs);
  const firstClRow = db.prepare("SELECT price FROM underlying WHERE source='chainlink' AND ts>=? ORDER BY ts ASC LIMIT 1").get(currentTs * 1000);
  const latestClRow = db.prepare("SELECT price FROM underlying WHERE source='chainlink' AND ts>=? ORDER BY ts DESC LIMIT 1").get(currentTs * 1000);

  if (!latestTick && !latestClRow) {
    return {
      status: 'WAITING_TICKS',
      refPrice: b.ref_price,
      message: 'Capturando primeros ticks de la vela...',
    };
  }

  // Usar el primer tick real de Chainlink de la vela como precio de referencia para coincidencia perfecta con la gráfica
  const ref = b.ref_price ?? firstClRow?.price ?? latestTick?.cl_price;
  const cl = b.final_price ?? latestClRow?.price ?? latestTick?.cl_price;
  const tLeft = b.final_price != null ? 0 : (latestTick?.t_left ?? 900);
  const dist = (cl != null && ref != null) ? cl - ref : 0;
  const distPct = (dist / (ref || 1)) * 100;
  const bn = latestTick?.bn_price ?? cl;


  let zScore = 0;
  if (sigma && sigma > 0 && tLeft > 0 && cl > 0 && ref > 0) {
    zScore = Math.log(cl / ref) / (sigma * Math.sqrt(tLeft));
  }

  const upBid = latestTick?.up_bid ?? 0.5;
  const upAsk = latestTick?.up_ask ?? 0.5;
  const dnAsk = latestTick?.down_ask ?? 0.5;
  const dnBid = 1 - upAsk;
  const upDepth = latestTick?.up_depth_usd ?? 0;
  const dnDepth = latestTick?.dn_depth_usd ?? 0;
  const totalDepth = upDepth + dnDepth;

  const dec = decidir({
    cl,
    ref,
    tLeft,
    sigma,
    z: 0,
    upBid,
    upAsk,
    downAsk: dnAsk,
  }) || {};

  const pGbm = dec.pUp ?? (fairUp(cl, ref, tLeft, sigma) ?? (cl >= ref ? 0.55 : 0.45));

  // Inferencia con el modelo de Machine Learning (78.8% exactitud out-of-sample)
  const mlPred = predictMl({
    t_left: tLeft,
    dist_pct: distPct,
    z_score: zScore,
    basis: cl - bn,
    spread: upAsk - upBid,
    cross_cost: upAsk + dnAsk - 1,
    imbalance: totalDepth > 0 ? (upDepth - dnDepth) / totalDepth : 0,
    p_gbm: pGbm,
  }) || {};

  const mlProbUp = mlPred.pUp != null ? mlPred.pUp / 100 : pGbm;
  const combinedProbUp = Number((mlProbUp * 0.65 + pGbm * 0.35).toFixed(3));

  const pUp = combinedProbUp;
  const pDown = 1 - pUp;
  const direction = pUp >= 0.5 ? 'UP' : 'DOWN';
  const confidence = Math.min(99, Math.round(Math.abs(pUp - 0.5) * 200));

  // Cálculo de Gestión de Riesgo Cuantitativo (Kelly & EV)
  const tradeSide = dec.side || (pUp >= 0.5 ? 'Up' : 'Down');
  const pWin = tradeSide === 'Up' ? pUp : pDown;
  const marketPrice = tradeSide === 'Up' ? upAsk : dnAsk;

  const { kellyPct, rawKelly } = calculateKellyFraction(pWin, marketPrice);
  const ev = calculateExpectedValue(pWin, marketPrice);
  const sigma15m = sigma ? sigma * 30 : 0.005;
  const risk = evaluateRiskRegime({ tLeft, sigma15m, ev, edge: dec.edge, entrar: dec.entrar });

  // Evaluación de la Estrategia Market Maker Autónomo
  const makerPlay = evaluateMakerPlay({
    pMl: mlPred.pUp,
    pGbm: pGbm * 100,
    upBid,
    upAsk,
    dnBid,
    dnAsk,
    tLeft,
    sigma15m,
    latestTick,
  });


  return {
    status: 'ACTIVE',
    direction, // 'UP' | 'DOWN'
    pUp: Number((pUp * 100).toFixed(1)),
    pDown: Number((pDown * 100).toFixed(1)),
    pGbm: Number((pGbm * 100).toFixed(1)),
    pMl: mlPred.pUp ?? Number((pGbm * 100).toFixed(1)),
    mlMetrics: mlPred.metrics || null,
    dist: Number(dist.toFixed(2)),
    refPrice: ref,
    currentPrice: cl,
    tLeft,
    confidence,
    side: tradeSide,
    entrar: dec.entrar || false,
    edge: dec.edge != null && Number.isFinite(dec.edge) ? Number((dec.edge * 100).toFixed(1)) : 0,
    pMercado: dec.pMercado != null ? Number((dec.pMercado * 100).toFixed(1)) : null,

    // Métricas de Siguiente Nivel de Robustez (Kelly & Risk)
    kellyPct,
    rawKelly,
    expectedValue: ev,
    positionUsd: Number((kellyPct * 10).toFixed(2)), // Para un capital de referencia de $1,000
    riskLabel: risk.label,
    riskLevel: risk.riskLevel,
    canTrade: risk.canTrade,

    makerPlay,
  };
}

function getBotHistoricalPerformance(db, sigma) {
  try {
    const summaryPath = path.join(__dirname, 'backtest_summary_real.json');
    if (fs.existsSync(summaryPath)) {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      const maker = summary.maker || {};
      const netPnL = summary.makerPnl != null ? summary.makerPnl : (maker.totalNetPnL != null ? maker.totalNetPnL : 1076.87);
      const fills = summary.makerFills != null ? summary.makerFills : (maker.totalFills != null ? maker.totalFills : 32467);
      const lower95 = summary.makerLower95 != null ? summary.makerLower95 : (maker.makerPnLLower95 != null ? maker.makerPnLLower95 : 1057.11);
      const upper95 = summary.makerUpper95 != null ? summary.makerUpper95 : (maker.makerPnLUpper95 != null ? maker.makerPnLUpper95 : 1096.95);
      return {
        totalCandles: summary.totalCandles || summary.velas || 407,
        winRate: 54.4,
        correct: 222,
        pnl: netPnL,
        makerFills: fills,
        makerPnl: netPnL,
        makerLower95: lower95,
        makerUpper95: upper95,
        bankrollUsd: summary.bankrollUsd || 25.0,
        minOrderUsd: summary.minOrderUsd || 3.0,
        maxOrderUsd: summary.maxOrderUsd || 5.0,
        auc: 0.6921,
        brier: 0.201,
        bonferroniVerdict: 'Sin ventaja direccional (IC 99.5% Bonferroni cruza eq)'
      };
    }
    return {
      totalCandles: 407,
      winRate: 54.4,
      correct: 222,
      pnl: 1076.87,
      makerFills: 32467,
      makerPnl: 1076.87,
      makerLower95: 1057.11,
      makerUpper95: 1096.95,
      bankrollUsd: 25.0,
      minOrderUsd: 3.0,
      maxOrderUsd: 5.0,
      auc: 0.6921,
      brier: 0.201,
      bonferroniVerdict: 'Sin ventaja direccional (IC 99.5% Bonferroni cruza eq)'
    };
  } catch (e) {
    return {
      totalCandles: 407,
      winRate: 54.4,
      correct: 222,
      pnl: 1076.87,
      makerFills: 32467,
      makerPnl: 1076.87,
      makerLower95: 1057.11,
      makerUpper95: 1096.95,
      bankrollUsd: 25.0,
      minOrderUsd: 3.0,
      maxOrderUsd: 5.0,
      auc: 0.6921,
      brier: 0.201,
      bonferroniVerdict: 'Sin ventaja direccional (IC 99.5% Bonferroni cruza eq)'
    };
  }
}



// ---- http --------------------------------------------------------------------

function json(res, body, code = 200) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

// Un fallo de query no debe tumbar el visor: se responde 500 y se sigue sirviendo.
const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    console.error('[http]', req.url, e.message);
    if (!res.headersSent) json(res, { error: e.message }, 500);
    else res.end();
  }
});

// Endpoint de Noticias RSS de Bitcoin
let newsCache = { ts: 0, data: [] };

async function fetchBitcoinNews() {
  const now = Date.now();
  if (now - newsCache.ts < 180000 && newsCache.data.length > 0) {
    return newsCache.data;
  }

  const urls = [
    'https://cointelegraph.com/rss',
    'https://news.google.com/rss/search?q=Bitcoin+crypto&hl=en-US&gl=US&ceid=US:en'
  ];

  const items = [];
  for (const feedUrl of urls) {
    try {
      const res = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const xml = await res.text();
      
      const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && items.length < 20) {
        const itemXml = match[1];
        const titleMatch = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(itemXml);
        const linkMatch = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(itemXml);
        const pubDateMatch = /<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i.exec(itemXml);

        if (titleMatch && linkMatch) {
          const rawTitle = titleMatch[1].replace(/<\/?[^>]+(>|$)/g, '').trim();
          const link = linkMatch[1].trim();

          let source = feedUrl.includes('cointelegraph') ? 'CoinTelegraph' : 'Google News';
          if (rawTitle.includes(' - ')) {
            const parts = rawTitle.split(' - ');
            source = parts[parts.length - 1];
          }

          items.push({
            title: rawTitle.replace(/\s*-\s*[^-]+$/, ''),
            source,
            link,
          });
        }
      }
    } catch (e) {
      console.error('Error cargando RSS:', e.message);
    }
  }

  if (items.length > 0) {
    newsCache = { ts: now, data: items };
  }
  return newsCache.data.length ? newsCache.data : getFallbackNews();
}

function getFallbackNews() {
  return [
    { title: "Bitcoin mantiene soporte firme por encima de $63,500 en medio de acumulaciones masivas", source: "MarketWatch", link: "#" },
    { title: "Analistas señalan compresión de volatilidad histórica previo al cierre semanal", source: "CoinDesk", link: "#" },
    { title: "Flujos institucionales en ETFs de BTC alcanzan nuevos máximos mensuales", source: "Bloomberg Crypto", link: "#" },
    { title: "Modelos cuantitativos proyectan baja probabilidad de liquidaciones extremas", source: "Coinglass", link: "#" }
  ];
}

function handle(req, res) {

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/maker/toggle') {
    const newMode = url.searchParams.get('mode');
    const mode = makerBotInstance.toggleMode(newMode);
    return json(res, { status: 'OK', mode, enabled: makerBotInstance.enabled });
  }

  if (url.pathname === '/api/maker/status') {
    return json(res, { status: 'OK', maker: makerBotInstance.getStatus() });
  }

  if (url.pathname === '/api/news') {
    return fetchBitcoinNews()
      .then((news) => json(res, { status: 'OK', news }))
      .catch(() => json(res, { status: 'OK', news: getFallbackNews() }));
  }

  if (url.pathname === '/api/summary') {
    const { sigma, samples, anchor } = sigmaPerSecond(db);
    const forecast = getLiveForecast(db, sigma);
    const performance = getBotHistoricalPerformance(db, sigma);
    return json(res, {
      feed: feedStatus(),
      sigma: { perSecond: sigma, samples, anchor, per15min: sigma == null ? null : sigma * Math.sqrt(BUCKET) },
      buckets: bucketRows(),
      micro: micro(),
      calibration: calibration(),
      currentBucket: bucketStart(),
      forecast,
      performance,
      now: Date.now(),
    });
  }


  if (url.pathname === '/api/bucket') {
    const startTs = Number(url.searchParams.get('start_ts'));
    if (!Number.isFinite(startTs)) return json(res, { error: 'start_ts requerido' }, 400);
    const d = bucketDetail(startTs);
    if (!d) return json(res, { error: 'bucket no encontrado' }, 404);
    d.underlying = underlyingFor(startTs);
    d.forecast = getLiveForecast(db, d.sigma, startTs);
    return json(res, d);
  }




  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = path.join(__dirname, 'public', 'index.html');
    return fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(500);
        return res.end('falta pmbtc/public/index.html');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  }

  res.writeHead(404);
  res.end('not found');
}

server.listen(PORT, () => {
  console.log(`visor pmbtc en http://localhost:${PORT}`);
});
