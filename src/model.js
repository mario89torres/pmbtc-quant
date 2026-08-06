'use strict';

// Modelo de referencia. Descriptivo, no normativo: sirve para ver si el mercado
// se desvía, no para afirmar cuál es el precio justo.

// Phi(x) con la aproximación de Abramowitz-Stegun 7.1.26 (error < 1.5e-7).
function normCdf(x) {
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

// Vol por segundo del subyacente desde los retornos log de chainlink.
// La ventana se ancla al último dato, no al reloj: si no, analizar en frío
// horas después de capturar devuelve cero muestras.
function sigmaPerSecond(db, lookbackSec = 6 * 3600) {
  const last = db.prepare("SELECT MAX(ts) m FROM underlying WHERE source='chainlink'").get();
  if (!last || !last.m) return { sigma: null, samples: 0, anchor: null };
  const since = last.m - lookbackSec * 1000;
  const rows = db
    .prepare("SELECT ts, price FROM underlying WHERE source='chainlink' AND ts >= ? ORDER BY ts")
    .all(since);
  let sum = 0;
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const dt = (rows[i].ts - rows[i - 1].ts) / 1000;
    // Huecos > 3s son reconexiones del feed, no volatilidad.
    if (dt <= 0 || dt > 3) continue;
    const r = Math.log(rows[i].price / rows[i - 1].price) / Math.sqrt(dt);
    sum += r * r;
    n++;
  }
  return { sigma: n > 30 ? Math.sqrt(sum / n) : null, samples: n, anchor: last.m };
}

// P(precio final >= ref) bajo GBM sin drift.
// Ignora el suavizado y el lag de chainlink, y que la vol no es constante
// dentro de la vela.
function fairUp(pt, pref, tLeft, sigma) {
  if (!(pt > 0) || !(pref > 0) || sigma == null) return null;
  if (tLeft <= 0) return pt >= pref ? 1 : 0;
  const d = Math.log(pt / pref) / (sigma * Math.sqrt(tLeft));
  return normCdf(d);
}

// Inversa de Phi (Acklam). Sirve para leer qué drift estandarizado implica el
// precio del mercado, y así poder corregirlo sin depender del nivel que
// calcularía nuestro modelo, que es la parte imprecisa.
function normInv(p) {
  if (!(p > 0 && p < 1)) return null;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
             3.754408661907416];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > ph) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

module.exports = { normCdf, normInv, sigmaPerSecond, fairUp };
