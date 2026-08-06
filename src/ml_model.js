'use strict';

const fs = require('fs');
const path = require('path');

let modelData = null;

function loadModel() {
  if (modelData) return modelData;
  const p = path.join(__dirname, 'ml_model.json');
  if (fs.existsSync(p)) {
    try {
      modelData = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      console.error('Error cargando ml_model.json:', e);
    }
  }
  return modelData;
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function predictMl(features) {
  const m = loadModel();
  if (!m) return null;

  const { feature_cols, scaler_mean, scaler_scale, coefficients, intercept } = m;

  let zSum = intercept;
  for (let i = 0; i < feature_cols.length; i++) {
    const key = feature_cols[i];
    const val = features[key] ?? 0;
    const mean = scaler_mean[i];
    const scale = scaler_scale[i] || 1;
    const scaledVal = (val - mean) / scale;
    zSum += scaledVal * coefficients[i];
  }

  const pUp = sigmoid(zSum);
  return {
    pUp: Number((pUp * 100).toFixed(1)),
    pDown: Number(((1 - pUp) * 100).toFixed(1)),
    direction: pUp >= 0.5 ? 'UP' : 'DOWN',
    confidence: Math.min(99, Math.round(Math.abs(pUp - 0.5) * 200)),
    metrics: m.metrics,
  };
}

module.exports = { predictMl, loadModel };
