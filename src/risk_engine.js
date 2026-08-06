'use strict';

// Motor de Gestión de Riesgo Cuantitativo y Criterio de Kelly (Kelly Criterion)

function calculateKellyFraction(pWin, marketPrice, kellyFraction = 0.25) {
  if (pWin <= 0 || pWin >= 1 || marketPrice <= 0 || marketPrice >= 1) {
    return { kellyPct: 0, rawKelly: 0 };
  }

  const b = (1 - marketPrice) / marketPrice;
  const qWin = 1 - pWin;

  const rawKelly = (pWin * b - qWin) / b;

  if (rawKelly <= 0) {
    return { kellyPct: 0, rawKelly: Number(rawKelly.toFixed(4)) };
  }

  const fractionalKelly = rawKelly * kellyFraction;
  const clampedKelly = Math.min(0.05, Math.max(0, fractionalKelly));

  return {
    kellyPct: Number((clampedKelly * 100).toFixed(2)),
    rawKelly: Number((rawKelly * 100).toFixed(2)),
  };
}

function calculateExpectedValue(pWin, marketPrice) {
  if (pWin == null || marketPrice == null) return 0;
  const ev = pWin * (1 - marketPrice) - (1 - pWin) * marketPrice;
  return Number(ev.toFixed(4));
}

function evaluateRiskRegime({ tLeft, sigma15m, ev, edge, entrar }) {
  const isHighVol = sigma15m != null && sigma15m > 0.006;
  const isUrgentTime = tLeft != null && (tLeft < 60 || tLeft > 840);
  const isDangerTime = tLeft != null && tLeft < 30;

  let riskLevel = 'LOW';
  let label = 'SEGURO 🟢';
  let canTrade = entrar && ev > 0;

  if (isDangerTime || (isHighVol && ev <= 0)) {
    riskLevel = 'HIGH';
    label = 'RIESGO ALTO 🔴';
    canTrade = false;
  } else if (isUrgentTime || isHighVol || ev <= 0.005) {
    riskLevel = 'MEDIUM';
    label = 'MODERADO 🟡';
  }

  return {
    riskLevel,
    label,
    canTrade,
    isHighVol,
    isUrgentTime,
  };
}

module.exports = {
  calculateKellyFraction,
  calculateExpectedValue,
  evaluateRiskRegime,
};
