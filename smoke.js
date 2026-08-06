// Prueba rápida: feed vivo + libro + escritura en DB, sin esperar un bucket.
const { open } = require('./src/db');
const { PriceFeed } = require('./src/feed');
const { bucketStart, fetchMarket, fetchBook, sweepCost } = require('./src/gamma');
(async () => {
  const db = open();
  const st = bucketStart();
  const m = await fetchMarket(st);
  console.log('mercado:', m.question, '| tokens ok:', !!m.upToken && !!m.downToken, '| tick', m.tickSize, '| min', m.minOrderSize);
  const feed = new PriceFeed({ log: () => {} });
  feed.start();
  await new Promise(r => setTimeout(r, 6000));
  console.log('chainlink:', feed.last.chainlink);
  console.log('binance  :', feed.last.binance);
  const up = await fetchBook(m.upToken);
  console.log('up best bid/ask:', up.bids[0], up.asks[0], '| niveles', up.bids.length, up.asks.length);
  console.log('barrer $100 en Up ask:', sweepCost(up.asks, 100));
  db.prepare("INSERT OR IGNORE INTO underlying (source,ts,price) VALUES ('chainlink',?,?)").run(feed.last.chainlink.ts, feed.last.chainlink.price);
  console.log('filas underlying:', db.prepare('SELECT COUNT(*) c FROM underlying').get().c);
  feed.stop(); process.exit(0);
})();
