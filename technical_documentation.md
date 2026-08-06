# 🛠️ Documentación Técnica del Proyecto `pmbtc`
## Sistema de Monitoreo Cuantitativo, Predicción ML y Provisión de Liquidez Autónomo para Mercados Binarios 15m de Bitcoin en Polymarket

---

### 1. Resumen Ejecutivo y Especificaciones del Sistema

- **Nombre del Sistema**: `pmbtc` (Polymarket Bitcoin 15m Quantitative Monitor & Autonomous Engine)
- **Ubicación del Proyecto**: `C:\Users\Invitadow\playdoit-monitor\pmbtc`
- **Stack Tecnológico**: Node.js (ES6+ / CommonJS), SQLite (`better-sqlite3`), Express/HTTP Native, Python 3.10+ (XGBoost, Scikit-Learn, Pandas, NumPy), SVG Charting Engine, HTML5/CSS3 (AMOLED Pitch Black & Neon Design System).
- **Puerto de Servicio**: `8787` (`http://localhost:8787/`)
- **Arquitectura de Datos**: Ingestión asíncrona multi-feed de Chainlink BTC/USD Oracle & Binance BTC/USDT con cálculo de Basis, Volatilidad ($\sigma$) instantánea y libro de órdenes de Polymarket.

---

### 2. Arquitectura de Archivos y Módulos del Código Fuente

```
pmbtc/
├── server.js                   # Servidor HTTP nativo REST API, agregación de feeds y enrutador principal
├── train_xgboost.py            # Script Python de entrenamiento del clasificador XGBoost con calibración Platt Scaling
├── hourly_analysis.js          # Script de evaluación empírica por franja horaria del bot direccional Kelly
├── hourly_maker_analysis.js    # Script de evaluación empírica por franja horaria de la estrategia Market Maker
├── pmbtc.db                    # Base de datos SQLite (tablas: buckets, ticks, orderbook, calibration)
├── src/
│   ├── ml_model.json           # Pesos exportados del ensamble XGBoost, medias/desviaciones de estandarización
│   ├── ml_model.js             # Motor de inferencia nativo Node.js para XGBoost (evaluación de árboles sin dependencias C++)
│   ├── model.js                # Implementación matemática del Movimiento Browniano Geométrico (GBM / normCdf)
│   ├── risk_engine.js          # Motor cuantitativo de Gestión de Riesgo (Kelly Fraccionado f*, EV, Régimen Volatilidad)
│   ├── maker_bot.js            # Motor de Estrategia Market Maker Autónomo (Cotizaciones Límite, Fill Simulation, Inventory Skew)
│   └── strategy.js             # Motor de reglas heurísticas y umbrales de filtrado (decidir)
└── public/
    └── index.html              # Dashboard Cyberpunk AMOLED Dark (3-grid charts, banner resultados, reloj, RSS ticker)
```

---

### 3. Modelo de Datos y Esquema SQLite (`pmbtc.db`)

#### Tabla `buckets` (Velas de 15 Minutos):
- `start_ts` (`INTEGER PRIMARY KEY`): Timestamp Unix del inicio de la vela.
- `ref_price` (`REAL`): Precio inicial de referencia de Chainlink BTC/USD.
- `final_price` (`REAL`): Precio final de cierre de Chainlink BTC/USD.
- `outcome` (`TEXT`): Resultado resuelto (`'Up'` | `'Down'`).
- `ticks` (`INTEGER`): Cantidad total de ticks registrados durante la vela.

#### Tabla `ticks` (Ticks Instantáneos):
- `ts` (`INTEGER`): Timestamp Unix del tick.
- `start_ts` (`INTEGER`): Timestamp de la vela correspondiente.
- `t_left` (`REAL`): Segundos restantes para el cierre ($0 \le T_{\text{left}} \le 900$).
- `cl_price` (`REAL`): Precio instantáneo de Chainlink BTC/USD.
- `bn_price` (`REAL`): Precio instantáneo de Binance BTC/USDT.
- `up_bid`, `up_ask`, `dn_bid`, `dn_ask` (`REAL`): Precios del libro de órdenes de Polymarket.
- `up_depth`, `dn_depth` (`REAL`): Profundidad del libro en USD.

---

### 4. Formulación Matemática y Modelos de Aprendizaje Machine Learning

#### 4.1 Movimiento Browniano Geométrico (GBM)
El precio del subyacente $S_t$ evoluciona según la Ecuación Diferencial Estocástica:
$$dS_t = \mu S_t dt + \sigma S_t dW_t$$

La probabilidad teórica de cierre $P(S_T > K \mid S_t)$ se expresa mediante la aproximación de Abramowitz-Stegun sobre la función de distribución acumulada normal $\Phi(z)$:
$$z = \frac{\ln(S_t / K) + (\mu - \frac{1}{2}\sigma^2) \Delta t}{\sigma \sqrt{\Delta t}}$$
$$P_{\text{GBM}} = \Phi(z)$$

#### 4.2 Clasificador XGBoost Calibrado por Platt Scaling
- **Features de Entrada (Standardized Features)**:
  1. `dist_pct`: Distancia porcentual $(S_t - K) / K$
  2. `t_left_ratio`: Proporción de tiempo restante $T_{\text{left}} / 900$
  3. `sigma_15m`: Volatilidad proyectada a 15 minutos
  4. `basis_cl_bn`: Diferencia entre Chainlink y Binance ($S_{\text{CL}} - S_{\text{BN}}$)
  5. `market_p_up`: Probabilidad mid-price del mercado Polymarket
  6. `edge_raw`: Diferencia entre el precio del mercado y el valor justo
- **Calibración Sigmoide (Platt Scaling)**: Convierte el margen del árbol $z_{\text{xgb}}$ en probabilidad calibrada $P_{\text{cal}} \in [0, 1]$:
  $$P_{\text{cal}} = \frac{1}{1 + e^{A \cdot z_{\text{xgb}} + B}}$$
- **Ensamble Ponderado Final**:
  $$P_{\text{Ensemble}} = 0.65 \cdot P_{\text{XGBoost}} + 0.35 \cdot P_{\text{GBM}}$$

---

### 5. Motor de Gestión de Riesgo y Criterio de Kelly (`src/risk_engine.js`)

#### 5.1 Criterio de Kelly Fraccionado ($f^*$)
Calcula la fracción óptima de capital a apostar en cada vela binaria:
$$f^* = \frac{p \cdot (b + 1) - 1}{b}$$
donde $p = P_{\text{Ensemble}}$, $b = \frac{1 - P_{\text{Market}}}{P_{\text{Market}}}$.
Se aplica una fracción de moderación ($\frac{1}{4} f^*$) para controlar el Drawdown máximo.

#### 5.2 Esperanza Matemática Neta ($EV$)
$$EV = p \cdot (1 - P_{\text{Market}}) - (1 - p) \cdot P_{\text{Market}}$$

---

### 6. Motor de Estrategia Market Maker Autónomo (`src/maker_bot.js`)

- **Cálculo de Cotizaciones Límite (*Maker Bids/Asks*)**:
  $$P_{\text{Bid, Target}} = \min(P_{\text{Ask, Market}} - 0.01, P_{\text{Ensemble}} - \text{Skew} - 0.015)$$
  $$P_{\text{Ask, Target}} = \max(P_{\text{Bid, Market}} + 0.01, P_{\text{Ensemble}} - \text{Skew} + 0.015)$$
- **Rebalanceo de Inventario (*Inventory Skewing*)**:
  $$\text{Skew} = \text{clamp}\left( -0.04, 0.04, \frac{\text{Inventory}}{50} \times 0.05 \right)$$

---

### 7. Endpoints de la API REST Server (`server.js`)

| Endpoint | Método | Descripción | Respuesta JSON Clave |
| :--- | :--- | :--- | :--- |
| `/api/summary` | `GET` | Resumen general en vivo, pronóstico ML, métricas de riesgo y performance. | `{ feed, forecast, performance, buckets, micro }` |
| `/api/bucket?start_ts=X` | `GET` | Detalle completo de una vela específica y sus ticks históricos. | `{ bucket, ticks, underlying, forecast }` |
| `/api/maker/status` | `GET` | Estado live del Bot Market Maker, PnL y llenados. | `{ status, maker: { mode, realizedPnl, filledOrdersCount } }` |
| `/api/maker/toggle?mode=X` | `GET` | Alterna modo entre `SIMULATION` y `REAL_LIVE`. | `{ status, mode, enabled }` |
| `/api/news` | `GET` | Ticker RSS de noticias de Bitcoin (CoinTelegraph & Google News). | `{ status, news: [{ title, source, link }] }` |
