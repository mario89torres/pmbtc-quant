'use strict';

// Regla de decisión del bot. Función pura: mismas entradas, misma salida.
// La usan por igual el backtest y el visor, para que lo que ves en pantalla sea
// exactamente lo que se evaluó — si divergen, el backtest deja de significar nada.

const { normCdf, normInv, fairUp } = require('./model');

// Parámetros fijados A PRIORI, no ajustados contra los resultados.
// Con ~150 velas, tocar estos números mirando el P&L es la forma más rápida de
// fabricar un edge que no existe.
const PARAMS = {
  // Fracción del desvío del basis que revierte. Medida por regresión sobre
  // 35k muestras: 0.473 a 5s, 0.473 a 10s, 0.510 a 20s, 0.472 a 30s. La otra
  // mitad es basis persistente entre feeds, no retraso.
  reversion: 0.47,

  // Ventaja mínima sobre el ask para entrar. Fijado por coste, no por P&L: al
  // comprar al ask ya se paga medio spread, así que se exige 1 centavo limpio
  // por encima. El backtest barre este umbral en vez de creerse un solo valor.
  minEdge: 0.01,

  // No entrar en los primeros 60s (la ref acaba de fijarse y el libro está
  // ancho) ni en los últimos 60s (con T→0 el modelo diverge: σ√T tiende a cero
  // y cualquier drift se convierte en probabilidad 0 o 1).
  minTLeft: 60,
  maxTLeft: 840,

  // Ventana de la media móvil del basis, en segundos.
  basisWindow: 60,
};

// Precio de chainlink una vez descontado el retraso frente a binance.
// z es el desvío del basis respecto a su media móvil: z<0 significa que
// chainlink va por debajo de binance y se espera que suba.
function precioAjustado(cl, z, reversion = PARAMS.reversion) {
  if (!(cl > 0) || z == null) return cl;
  return cl * Math.exp(-reversion * z);
}

// Decide qué haría el bot en un instante. Devuelve null si no hay que hacer nada.
//
//   cl, ref, tLeft, sigma : estado del subyacente y de la vela
//   z                     : desvío del basis (null si no se puede calcular)
//   upAsk, downAsk        : lo que cuesta comprar cada lado AHORA
// Probabilidad de partida: la del MERCADO, no la del modelo propio.
//
// Medido sobre 67.748 ticks, el modelo GBM discrepa del mercado 6.7 centavos de
// media con sesgo casi nulo (−0.7c): es imprecisión, no dirección. La señal del
// basis vale 1-2 centavos de probabilidad, así que partir del modelo la ahoga
// bajo su propio ruido y lo que se acaba operando es el error del modelo.
//
// Por eso se toma el precio del mercado como nivel y el modelo solo aporta la
// SENSIBILIDAD (cuánta probabilidad mueve un dólar de subyacente), que es mucho
// menos frágil que el nivel.
function decidir({ cl, ref, tLeft, sigma, z, upBid, upAsk, downAsk }, params = PARAMS) {
  if (cl == null || ref == null || sigma == null || z == null) return null;
  if (tLeft < params.minTLeft || tLeft > params.maxTLeft) return null;
  if (upBid == null || upAsk == null) return null;

  const clAjustado = precioAjustado(cl, z, params.reversion);

  const pMercado = (upBid + upAsk) / 2;
  const dMercado = normInv(pMercado);
  if (dMercado == null) return null;

  // Movimiento previsto del subyacente, en unidades estandarizadas.
  const delta = Math.log(clAjustado / cl) / (sigma * Math.sqrt(tLeft));
  const pUp = normCdf(dMercado + delta);

  // Cuánto se gana comprando cada lado al precio que pide el libro.
  const edgeUp = upAsk != null ? pUp - upAsk : -Infinity;
  const edgeDown = downAsk != null ? (1 - pUp) - downAsk : -Infinity;

  const side = edgeUp >= edgeDown ? 'Up' : 'Down';
  const edge = Math.max(edgeUp, edgeDown);
  const precio = side === 'Up' ? upAsk : downAsk;

  const base = {
    pUp,                              // mercado corregido por el basis
    pMercado,                         // lo que dice el libro ahora
    pModelo: fairUp(cl, ref, tLeft, sigma), // GBM puro, solo informativo
    clAjustado,
    delta,                            // desplazamiento aportado por el basis
    side,
    edge,
    precio,
  };

  if (edge < params.minEdge || precio == null) return { ...base, entrar: false };
  return { ...base, entrar: true };
}

module.exports = { decidir, precioAjustado, PARAMS, normCdf };
