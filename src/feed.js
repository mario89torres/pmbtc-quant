'use strict';

const WS_URL = 'wss://ws-live-data.polymarket.com';

// Feed de precios de Polymarket. Dos fuentes:
//   chainlink btc/usd  -> es la que resuelve el mercado (~1 tick/s, con lag)
//   binance  btcusdt   -> misma cadencia pero sin lag, sirve de adelanto
// El nivel de ambas NO es comparable (hay basis de decenas de dólares);
// solo los cambios de binance son informativos sobre chainlink.
class PriceFeed {
  constructor({ onTick = () => {}, log = console.log } = {}) {
    this.onTick = onTick;
    this.log = log;
    this.ws = null;
    this.closed = false;
    this.last = { chainlink: null, binance: null };
    this.backoff = 1000;
  }

  start() {
    this.closed = false;
    this._connect();
  }

  stop() {
    this.closed = true;
    if (this.ws) this.ws.close();
  }

  _connect() {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 1000;
      this.log('[feed] conectado');
      ws.send(
        JSON.stringify({
          action: 'subscribe',
          subscriptions: [
            { topic: 'crypto_prices_chainlink', type: '*' },
            { topic: 'crypto_prices', type: 'update', filters: '{"symbol":"btcusdt"}' },
          ],
        })
      );
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // el server manda algún frame vacío al abrir
      }
      const p = msg.payload;
      if (!p || !p.symbol) return;

      if (msg.topic === 'crypto_prices_chainlink' && p.symbol === 'btc/usd') {
        this._emit('chainlink', p);
      } else if (msg.topic === 'crypto_prices' && p.symbol === 'btcusdt') {
        this._emit('binance', p);
      }
    };

    ws.onerror = (e) => this.log('[feed] error', e.message || e.type);

    ws.onclose = (e) => {
      if (this.closed) return;
      this.log(`[feed] cerrado (${e.code}), reconectando en ${this.backoff}ms`);
      setTimeout(() => this._connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
  }

  _emit(source, p) {
    const tick = { source, ts: p.timestamp, price: p.value, raw: p.full_accuracy_value };
    this.last[source] = tick;
    this.onTick(tick);
  }
}

module.exports = { PriceFeed, WS_URL };
