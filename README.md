# ⚡ pmbtc-quant

**Framework cuantitativo de predicción probabilística y provisión de liquidez autónoma para mercados binarios de Bitcoin (15 min) en Polymarket.**

[![Licencia](https://img.shields.io/badge/License-MIT-brightgreen.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![Backtest](https://img.shields.io/badge/Backtest-N%3D407_velas-orange.svg)](./backtest.js)
[![Whitepaper](https://img.shields.io/badge/Whitepaper-PDF_Auditado-purple.svg)](./research_paper_es.pdf)

---

## 📑 Tabla de contenidos

1. [¿Qué es este proyecto?](#-qué-es-este-proyecto)
2. [Arquitectura del sistema](#-arquitectura-del-sistema)
3. [Fundamento matemático: modelo GBM](#-fundamento-matemático-modelo-de-movimiento-browniano-geométrico-gbm)
4. [Señal de reversión del basis (estrategia principal)](#-señal-de-reversión-del-basis-estrategia-principal)
5. [Modelo de Machine Learning](#-modelo-de-machine-learning)
6. [Motor de gestión de riesgo (Criterio de Kelly)](#-motor-de-gestión-de-riesgo-criterio-de-kelly)
7. [Bot de Market Making](#-bot-de-market-making)
8. [Metodología de backtesting](#-metodología-de-backtesting)
9. [Resultados empíricos](#-resultados-empíricos)
10. [Módulo secundario: bot de ejecución en Python](#-módulo-secundario-bot-de-ejecución-en-python)
11. [API REST del servidor](#-api-rest-del-servidor)
12. [Instalación y ejecución](#-instalación-y-ejecución)
13. [Limitaciones conocidas y hoja de ruta](#-limitaciones-conocidas-y-hoja-de-ruta)
14. [Descargo de responsabilidad](#️-descargo-de-responsabilidad)

---

## 🎯 ¿Qué es este proyecto?

Polymarket lista mercados de predicción binarios de 15 minutos sobre si el precio de BTC/USD cerrará por encima (`Up`) o por debajo (`Down`) de un precio de referencia fijado al inicio de la vela. Cada contrato paga \$1 si acierta y \$0 si falla, y su precio de mercado (entre \$0 y \$1) puede leerse como una probabilidad implícita.

`pmbtc-quant` es un sistema que:

1. **Ingiere** precios de BTC/USD en tiempo real desde dos fuentes independientes (oráculo Chainlink y spot de Binance) y el libro de órdenes de Polymarket.
2. **Modela** la probabilidad de cierre `Up`/`Down` con tres enfoques complementarios: un modelo analítico (GBM), una señal de microestructura (reversión del basis entre feeds) y un modelo estadístico entrenado (regresión logística calibrada).
3. **Contrasta** esa probabilidad contra el precio que pide el mercado para decidir si existe una ventaja (*edge*) ejecutable.
4. **Audita** los resultados con metodología estadística que evita los errores más comunes de los "bots de trading" publicados en abierto: pseudoreplicación a nivel de tick, fuga de información al vencimiento, y comparaciones múltiples sin corrección.

El propósito declarado del repositorio no es vender una estrategia ganadora, sino **documentar, con honestidad metodológica, qué funciona, qué no, y por qué** — el propio README original reconoce, tras corregir por comparaciones múltiples (Bonferroni), que la estrategia direccional *taker* no logra una ventaja estadísticamente distinguible del azar. Esa autocrítica es, en sí misma, la parte más valiosa del proyecto.

---

## 🏗️ Arquitectura del sistema

```
pmbtc-quant/
├── collect.js              # Ingesta continua: Chainlink + Binance + libro de Polymarket → SQLite
├── server.js                # Servidor HTTP nativo, SOLO LECTURA sobre la base de datos (dashboard + API)
├── backtest.js               # Backtest determinista de la regla de decisión (src/strategy.js)
├── run_full_rigorous_backtest.js   # Auditoría a nivel de vela (N=407), sin pseudoreplicación
├── hourly_analysis.js        # Desempeño de la señal direccional por franja horaria
├── hourly_maker_analysis.js  # Desempeño del market maker por franja horaria
├── lag.js                     # Medición del retraso (lag) entre Chainlink y Binance
├── train_xgboost.py           # Entrenamiento y validación out-of-sample del modelo predictivo
├── extract_ml_data.js        # Construcción del dataset de entrenamiento desde SQLite
├── src/
│   ├── db.js                  # Apertura/esquema de la base SQLite
│   ├── gamma.js                # Cliente de la API Gamma/CLOB de Polymarket, definición de la vela (BUCKET=900s)
│   ├── feed.js                 # Normalización de los feeds de precio
│   ├── model.js                # Movimiento Browniano Geométrico: Φ(z), Φ⁻¹(p), volatilidad realizada
│   ├── strategy.js             # Regla de decisión: reversión del basis (función pura, usada por backtest y visor)
│   ├── risk_engine.js          # Kelly fraccionado, esperanza matemática, régimen de riesgo
│   ├── ml_model.js             # Motor de inferencia del modelo estadístico entrenado
│   └── ml_model.json           # Parámetros exportados (medias/escalas del estandarizador, coeficientes)
├── polymarket_bot/             # Módulo secundario en Python/FastAPI: ejecución real y paper trading
├── public/index.html          # Dashboard (gráficos en vivo, reloj de vela, estado del feed)
└── docker-compose.yml         # Colector + servidor como servicios independientes sobre un volumen compartido
```

**Principio de diseño clave**: `src/strategy.js` es una función pura (`decidir(...)`) que recibe el estado del mercado y devuelve una decisión, sin efectos secundarios. Tanto `backtest.js` como el visor en vivo importan esa misma función. Esto no es un detalle cosmético: si el backtest evaluara una lógica distinta a la que se muestra en pantalla, el número de rendimiento dejaría de ser una medición del sistema real.

---

## 📐 Fundamento matemático: modelo de Movimiento Browniano Geométrico (GBM)

El precio subyacente $S_t$ se modela como un proceso estocástico:

$$dS_t = \mu S_t\, dt + \sigma S_t\, dW_t$$

Bajo este modelo, la probabilidad de que el precio cierre por encima del precio de referencia $K$ al vencimiento tiene forma cerrada:

$$z = \frac{\ln(S_t / K)}{\sigma \sqrt{\Delta t}}, \qquad P(S_T \ge K) = \Phi(z)$$

donde $\Phi$ es la función de distribución acumulada normal estándar, aproximada numéricamente con la fórmula de Abramowitz-Stegun 7.1.26 (error $<1.5\times10^{-7}$) en `src/model.js`, ya que Node.js no incluye una `erf()` nativa.

La volatilidad $\sigma$ **no se fija por parámetro**: se estima en cada instante a partir de los retornos logarítmicos de Chainlink en una ventana móvil de 6 horas, descartando huecos mayores a 3 segundos (reconexiones del feed, no volatilidad real) y exigiendo al menos 30 observaciones válidas antes de reportar un valor.

> **Nota de honestidad del propio código**: el comentario en `model.js` es explícito sobre las limitaciones — el modelo es *"descriptivo, no normativo: sirve para ver si el mercado se desvía, no para afirmar cuál es el precio justo"*. Ignora el suavizado y el lag de Chainlink, y asume volatilidad constante dentro de cada vela de 15 minutos, lo cual es una simplificación conocida.

---

## 🔀 Señal de reversión del basis (estrategia principal)

Esta es la pieza más interesante del repositorio desde el punto de vista de microestructura de mercado, y **no la que aparece destacada en el README original**.

**Idea central**: Chainlink y Binance no reportan el mismo precio en el mismo instante — hay un basis (diferencia relativa) entre ambos feeds que fluctúa por latencia de oráculo y diferencias de liquidez. Parte de ese basis es ruido persistente entre feeds, pero otra parte revierte: cuando Chainlink se desvía de Binance, tiende a corregirse parcialmente hacia él en los segundos siguientes.

La magnitud de esa reversión **se midió empíricamente por regresión sobre ~35.000 muestras**, no se asumió:

| Horizonte | Fracción que revierte |
|---|---|
| 5s | 0.473 |
| 10s | 0.473 |
| 20s | 0.510 |
| 30s | 0.472 |

El resultado converge a **≈0.47** en todos los horizontes, lo que sugiere una fracción de reversión estructural (no un artefacto de la ventana elegida). El parámetro `reversion = 0.47` en `src/strategy.js` proviene directamente de esta medición.

**Punto metodológico importante — por qué se parte del precio del mercado y no del modelo propio**: el código documenta que, sobre 67.748 ticks, el modelo GBM discrepa del precio de mercado en 6.7 centavos de media, con sesgo casi nulo (−0.7c). Es decir, el GBM tiene *ruido*, no *dirección*. Como la señal de reversión del basis vale apenas 1–2 centavos de probabilidad, si se partiera del nivel que calcula el GBM, esa señal quedaría completamente ahogada por el propio error del modelo. Por eso la regla parte del **punto medio del libro de Polymarket** como nivel base, y usa el GBM únicamente para la *sensibilidad* (cuánto mueve la probabilidad un desplazamiento del subyacente), que es una cantidad mucho más estable que el nivel absoluto.

**Filtros de entrada** (fijados *a priori*, antes de ver resultados, precisamente para no ajustar el umbral mirando el propio P&L):

- Ventana operativa: entre 60s y 840s desde el inicio de la vela (se excluyen los primeros 60s, cuando el libro aún está ancho, y los últimos 60s, donde $\sigma\sqrt{T} \to 0$ y el modelo diverge hacia probabilidades 0/1 espurias).
- Edge mínimo de entrada: 1 centavo neto sobre el *ask* — no sobre el *mid*, porque comprar al mid es un precio al que nadie te vende realmente.

---

## 🤖 Modelo de Machine Learning

Aquí es donde vale la pena leer el código fuente en vez de confiar solo en el nombre del archivo, porque hay una discrepancia real entre lo documentado y lo desplegado que conviene explicar con precisión:

### Lo que se entrena (`train_xgboost.py`)

1. Se entrena un **`XGBClassifier`** (150 árboles, profundidad 4) sobre 8 *features* (`t_left`, `dist_pct`, `z_score`, `basis`, `spread`, `cross_cost`, `imbalance`, `p_gbm`), con partición **cronológica** por vela (80% train / 20% test out-of-sample) — no aleatoria, para no filtrar información del futuro dentro de la misma vela al set de entrenamiento.
2. Se calibra con `CalibratedClassifierCV` (Platt Scaling, sigmoide, 5-fold).
3. Sobre el set de test se reportan las métricas: **AUC-ROC 0.879, Accuracy 78.9%, Brier Score 0.149**.

### Lo que efectivamente corre en producción (`src/ml_model.js`)

El motor de inferencia en Node.js **no evalúa árboles de decisión**. Carga únicamente `coefficients`, `intercept` y los parámetros de estandarización (`scaler_mean`, `scaler_scale`) de `ml_model.json`, y calcula:

$$P_{up} = \sigma\!\left(\beta_0 + \sum_i \beta_i \cdot \frac{x_i - \mu_i}{s_i}\right)$$

Es decir, es una **regresión logística lineal**, no una traducción del ensamble de árboles de XGBoost. Revisando `train_xgboost.py` se confirma el origen: los coeficientes exportados provienen de un `LogisticRegression` entrenado **por separado**, sobre las mismas *features* estandarizadas — no de una destilación de las predicciones de XGBoost hacia el modelo lineal.

**Consecuencia práctica**: las métricas que aparecen en `ml_model.json` (`metrics.auc_roc = 0.879`, etc.) describen el desempeño del **XGBoost calibrado**, no el de la regresión logística que realmente genera `pMl` en el dashboard y en el bot. Es razonable esperar que el modelo lineal desplegado tenga menor poder predictivo que el ensamble de árboles que reporta esas métricas, precisamente porque no captura interacciones no lineales entre *features* (p. ej. cómo `dist_pct` importa de forma distinta según `t_left`).

> Esto no invalida el enfoque — una regresión logística ligera, sin dependencias nativas de C++, es una decisión de ingeniería razonable para inferencia en el *hot path* de Node.js — pero si el objetivo es "de forma científica", la corrección honesta es: **las métricas reportadas y el modelo desplegado no son el mismo objeto**, y cualquier evaluación de precisión real del sistema en producción debería recalcularse sobre las salidas de `ml_model.js`, no citarse desde `ml_model.json`.

### Ensamble final mostrado al usuario

$$P_{\text{Ensemble}} = 0.65 \cdot P_{\text{Logístico}} + 0.35 \cdot P_{\text{GBM}}$$

Los pesos (0.65 / 0.35) están fijados por diseño; el repositorio no documenta que se hayan optimizado por validación cruzada.

---

## 💰 Motor de gestión de riesgo (Criterio de Kelly)

`src/risk_engine.js` implementa el criterio de Kelly para apuestas binarias con retorno neto $b$:

$$f^* = \frac{p\,(b+1) - 1}{b}, \qquad b = \frac{1 - P_{\text{mercado}}}{P_{\text{mercado}}}$$

donde $p$ es la probabilidad estimada por el ensamble. El código aplica **Kelly fraccionado** (¼ del Kelly completo) y además un techo duro de 5% del capital por operación (`Math.min(0.05, ...)`), independientemente de lo que sugiera la fórmula — una salvaguarda razonable dado que $f^*$ es muy sensible a errores de calibración en $p$.

La esperanza matemática neta se calcula como:

$$EV = p\,(1 - P_{\text{mercado}}) - (1-p)\,P_{\text{mercado}}$$

y `evaluateRiskRegime()` clasifica cada instante en tres regímenes (`LOW` / `MEDIUM` / `HIGH`) combinando: tiempo restante extremo ($t<30s$ o $t<60s$ / $t>840s$), volatilidad anualizada por encima de 0.006, y EV insuficiente — bloqueando operaciones cuando cualquiera de esas condiciones de "fuerza mayor" se cumple.

---

## ⚡ Bot de Market Making

`src/maker_bot.js` implementa un proveedor de liquidez que cotiza órdenes límite a ambos lados del libro y gestiona su inventario:

$$P_{\text{bid}} = \min(P_{\text{ask,mercado}} - 0.01,\; P_{\text{ensemble}} - \text{Skew} - 0.015)$$
$$P_{\text{ask}} = \max(P_{\text{bid,mercado}} + 0.01,\; P_{\text{ensemble}} - \text{Skew} + 0.015)$$

**Inventory skewing**: para evitar acumular una posición direccional grande, el precio justo se desplaza en función del inventario neto acumulado:

$$\text{Skew} = \text{clamp}\left(-0.04,\ 0.04,\ \frac{\text{Inventario}}{50}\times 0.05\right)$$

Cuantos más contratos `Up` netos tenga el bot, más baja su *bid* y su *ask* (para vender más fácil e incentivar menos compra), y viceversa.

**Filtros de seguridad**: el bot cancela todas las órdenes activas y pausa la cotización si $t_{\text{left}} < 30s$, $t_{\text{left}} > 870s$, o $\sigma_{15m} > 0.012$ (volatilidad anómala) — condiciones bajo las cuales cotizar un mercado de opción binaria es estructuralmente peligroso (gamma/theta extremos cerca del vencimiento).

> **Nota de auditoría sobre `simulateOrderFills()`**: el simulador de llenado de órdenes en modo `SIMULATION` decide si una orden se llena mediante `Math.random()` — un 25% de probabilidad de compra llenada, 25% de venta llenada (si hay inventario), independientemente del precio cotizado, la profundidad real del libro o si el precio de mercado efectivamente cruzó la cotización. Es una **simulación de frecuencia de llenado**, útil para probar la lógica de inventario y PnL contable del bot, pero **no un motor de microestructura que replique fills reales contra el libro de órdenes de Polymarket**. Los \$4,447.86 USD de PnL neto reportados en el whitepaper con 20,700 fills deben leerse en ese contexto: son el resultado de una regla de skewing y un modelo de fricción (18%) aplicados sobre una tasa de llenado sintética, no sobre un replay del libro de órdenes histórico tick a tick. Antes de operar con capital real, esta pieza es la que más se beneficiaría de un reemplazo por un simulador basado en el libro de órdenes registrado en `ticks` (columnas `up_depth`, `dn_depth`).

---

## 🔬 Metodología de backtesting

`backtest.js` y `run_full_rigorous_backtest.js` están diseñados explícitamente para evitar los tres errores más comunes en backtests de estrategias intradía publicados en abierto:

1. **Pseudoreplicación por tick**: evaluar la señal en cada tick de una vela (potencialmente cientos) e informar todas esas evaluaciones como "operaciones" infla artificialmente el tamaño muestral. La regla implementada toma **como mucho una entrada por vela** (la primera señal que cumple el umbral), de modo que $N$ = número de velas, no de ticks.
2. **Fuga de información al vencimiento**: cerca de $t_{\text{left}} \to 0$, el resultado de la vela es casi determinista (el AUC medido en esa franja llega a 0.941, prácticamente resolución trivial del precio). Incluir esa franja en el backtest general sobreestima la capacidad predictiva real del sistema en el momento en que de verdad hay que decidir. Por eso el análisis reporta el AUC **desagregado por franja de $t_{\text{left}}$** en vez de un único número agregado.
3. **Comparaciones múltiples sin corregir**: al barrer 10 umbrales de edge distintos buscando cuál "funciona", la probabilidad de encontrar uno significativo por puro azar crece. El README original aplica corrección de **Bonferroni** ($k=10$) sobre los intervalos de confianza, y el resultado es honesto: **al 99.5% de confianza, todos los umbrales cruzan el punto de equilibrio** — no hay evidencia de ventaja ejecutable en la estrategia direccional *taker*.

Reglas adicionales, fijadas antes de ver resultados:
- La entrada se ejecuta al **ask** (cruzando el spread), no al mid.
- $\sigma$ se estima **solo con datos anteriores al inicio de la vela** evaluada — usar volatilidad de la vela completa filtraría información del futuro hacia el pasado.
- Los parámetros de la estrategia (`reversion`, `minEdge`, `minTLeft`/`maxTLeft`) están fijados por medición o por costo, **no ajustados contra el P&L resultante** — con ~150–400 velas, ajustar el umbral mirando el resultado es la forma más rápida de fabricar un edge que no existe.

---

## 📊 Resultados empíricos

> Cifras tomadas del whitepaper auditado (`research_paper_es.pdf`) y `backtest_summary_real.json`. Se presentan junto con sus intervalos de confianza porque, con tamaños muestrales de cientos de velas, el intervalo es la parte que decide si el número significa algo.

### Señal direccional (*taker*) — a nivel de vela, $N=407$

- **AUC-ROC global**: 0.6921.
- **AUC por franja de $t_{\text{left}}$**: 0.528 (750–900s, ≈azar) → 0.612 (450–750s) → 0.745 (150–450s) → 0.941 (0–150s, resolución casi determinista).
- **Barrido de umbral con Bonferroni ($k=10$)**: todos los umbrales evaluados (0.1c a 3.0c) cruzan el punto de equilibrio al 99.5% de confianza → **la estrategia direccional no ofrece ventaja estadísticamente distinguible del azar**.

### Market Maker

| Métrica | Bruto | Neto (fricción 18%) | IC 95% Bootstrap |
|---|---:|---:|---|
| PnL acumulado | +\$5,424.22 | +\$4,447.86 | [+\$4,371.73, +\$4,519.92] |
| Fills ejecutados | 20,700 | 20,700 | — |

El modelo de fricción del 18% se desglosa en: 8% latencia del *relayer* de Polygon (~120ms), 7% *slippage* (descuento de \$0.005/contrato), 3% *gas fees* por rebalanceo en lote. **Léase junto con la nota de la sección anterior sobre `simulateOrderFills()`**: este PnL proviene de una tasa de llenado sintética, no de un replay contra el libro de órdenes histórico.

---

## 🐍 Módulo secundario: bot de ejecución en Python

`polymarket_bot/` es una suite independiente en **Python 3.8+ / FastAPI**, separada del núcleo en Node.js, orientada a ejecución real:

- **Paper trading / dry-run**: simula Grid Trading y Market Making emparejando contra el libro de órdenes real, sin arriesgar capital.
- **Cliente CLOB en vivo** (`py-clob-client`): firma de órdenes vía **EIP-712** y envío a Polygon Mainnet con credenciales L2 de Polymarket.
- **Dashboard alternativo** en `http://localhost:8000` para exploración de mercados vía la API Gamma.

```bash
cd polymarket_bot
pip install -r requirements.txt
python backend/main.py
```

---

## 🌐 API REST del servidor

`server.js` es explícitamente de **solo lectura** sobre la base de datos que llena `collect.js` — no coloca ni cancela órdenes.

| Endpoint | Método | Descripción |
|---|---|---|
| `/api/summary` | `GET` | Estado del feed, pronóstico del ensamble, métricas de riesgo, resumen de performance. |
| `/api/bucket?start_ts=X` | `GET` | Detalle de una vela específica y sus ticks históricos. |
| `/api/maker/status` | `GET` | Estado del bot Market Maker: modo, PnL, inventario, fills. |
| `/api/maker/toggle?mode=X` | `GET` | Alterna entre `SIMULATION` y `REAL_LIVE`. |
| `/api/news` | `GET` | Ticker de noticias de Bitcoin (CoinTelegraph / Google News). |

---

## 💻 Instalación y ejecución

### Servidor principal (Node.js ≥ 22)

```bash
git clone https://github.com/mario89torres/pmbtc-quant.git
cd pmbtc-quant
npm install

# Colector: llena pmbtc.db con datos en vivo (debe correr de forma continua)
npm run collect

# Dashboard de solo lectura en http://localhost:8787
npm start

# Backtest determinista sobre las velas ya resueltas
npm run backtest

# Auditoría rigurosa a nivel de vela (N=407, sin pseudoreplicación)
npm run backtest:full
```

### Con Docker

```bash
docker compose up
# expone el dashboard en http://localhost:8787
# el colector corre como servicio separado sobre un volumen compartido
```

### Re-entrenar el modelo estadístico

```bash
python train_xgboost.py       # entrena XGBoost + regresión logística, exporta src/ml_model.json
python generate_honest_plots.py   # regenera las gráficas sin pseudoreplicación
```

---

## 🔭 Limitaciones conocidas y hoja de ruta

Reunidas aquí explícitamente, porque el propio proyecto valora la honestidad metodológica por encima de la promoción:

- [ ] **Desalinear métricas reportadas y modelo desplegado**: recalcular AUC/Brier/Accuracy directamente sobre las salidas de `ml_model.js` (regresión logística), no sobre las del XGBoost calibrado que hoy aparecen en `ml_model.json`.
- [ ] **Reemplazar `simulateOrderFills()`** por un simulador de llenado basado en el libro de órdenes histórico (`up_depth`/`dn_depth` en la tabla `ticks`) en vez de una probabilidad fija de 25%/25%.
- [ ] **Modelar latencia y profundidad real** en `backtest.js` — hoy asume ejecución instantánea al ask visible; `sweepCost()` en `src/gamma.js` es el punto de partida señalado en el propio código.
- [ ] **Confirmar el esquema real de fees** de Polymarket/Polygon — el código señala que hoy no están confirmadas.
- [ ] **Ampliar la muestra** ($N=407$ velas es aproximadamente 4.2 días de mercado continuo) para reducir el ancho de los intervalos de confianza antes de sacar conclusiones más fuertes sobre la señal direccional.
- [ ] **Validar los pesos del ensamble (0.65/0.35)** por validación cruzada en vez de un valor fijado por diseño.

---

## ⚠️ Descargo de responsabilidad

Este repositorio es un marco de investigación y auditoría algorítmica, no asesoramiento financiero. Los resultados de backtest no garantizan desempeño futuro; el mercado real de Polymarket introduce fricciones (latencia, slippage, gas, profundidad limitada) que el simulador solo aproxima parcialmente, según se detalla en las secciones anteriores. Se recomienda validación *walk-forward* y *paper trading* prolongado antes de desplegar cualquier estrategia con capital real.

---

**Repositorio**: [github.com/mario89torres/pmbtc-quant](https://github.com/mario89torres/pmbtc-quant)
**Whitepapers**: [Español (PDF)](./research_paper_es.pdf) · [Inglés (PDF)](./research_paper_en.pdf) · [Documentación técnica](./technical_documentation.md)
