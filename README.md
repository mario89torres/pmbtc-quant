# ⚡ pmbtc-quant: Marco Cuantitativo de Predicción y Market Making Autónomo para Bitcoin en Polymarket

[![Licencia](https://img.shields.io/badge/License-MIT-brightgreen.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Empírico](https://img.shields.io/badge/Backtest-406_Velas_Reales-orange.svg)](./backtest.js)
[![Academia](https://img.shields.io/badge/Whitepaper-PDF_Emp%C3%ADrico-purple.svg)](./research_paper_es.pdf)

**`pmbtc-quant`** es un marco cuantitativo de alta frecuencia diseñado para el análisis probabilístico, predicción binaria y provisión autónoma de liquidez en opciones binarias a 15 minutos de Bitcoin (BTC/USD) en mercados de predicción descentralizados (**Polymarket**).

> ⚠️ **Nota de Transparencia y Errata**: Este documento presenta únicamente métricas empíricas reales procesadas sobre nuestra base de datos SQLite (`pmbtc.db`) de **406 velas de 15 minutos resueltas (179,065 muestras de ticks)**.

---

## 📑 Tabla de Contenidos
- [Auditoría Empírica Rigurosa (Base SQLite `pmbtc.db`)](#-auditoría-empírica-rigurosa-base-sqlite-pmbtcdb)
- [⚡ Estrategia del Creador de Mercado Autónomo (Market Maker)](#-estrategia-del-creador-de-mercado-autónomo-market-maker)
- [Modelos Predictivos y Control de Riesgo](#modelos-predictivos-y-control-de-riesgo)
- [Instalación y Ejecución del Backtest](#instalación-y-ejecución-del-backtest)
- [Whitepaper Técnico y Estudio de Caso](#whitepaper-técnico-y-estudio-de-caso)

---

## 📊 Auditoría Empírica Rigurosa (Base SQLite `pmbtc.db`)

Para garantizar rigor científico y evitar el sesgo de selección o *p-hacking*, se aplicó la **Corrección de Bonferroni para comparaciones múltiples ($k=10$ pruebas, $\alpha=0.005$, IC $99.5\%$)** al barrido de umbrales direccionales.

### 1. Barrido Direccional con Corrección de Bonferroni

| Umbral (Edge) | Ops | Aciertos | WinRate (%) | IC 95% Estándar | IC 99.5% Bonferroni | Equilibrio | Veredicto Riguroso |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **0.1c (0.1%)** | 405 | 220 | 54.3% | $[49.5\%, 59.2\%]$ | $[47.4\%, 61.3\%]$ | 51.1% | Indistinguible del azar 🟡 |
| **0.5c (0.5%)** | 396 | 200 | 50.5% | $[45.6\%, 55.4\%]$ | $[43.5\%, 57.6\%]$ | 50.4% | Indistinguible del azar 🟡 |
| **1.0c (1.0%)** | 356 | 191 | 53.7% | $[48.5\%, 58.8\%]$ | $[46.2\%, 61.1\%]$ | 51.0% | Indistinguible del azar 🟡 |
| **1.5c (1.5%)** | 314 | 161 | 51.3% | $[45.7\%, 56.8\%]$ | $[43.4\%, 59.2\%]$ | 50.2% | Indistinguible del azar 🟡 |
| **2.0c (2.0%)** | 264 | 141 | 53.4% | $[47.4\%, 59.4\%]$ | $[44.8\%, 62.0\%]$ | 50.7% | Indistinguible del azar 🟡 |
| **3.0c (3.0%)** | 169 | 98 | 58.0% | $[50.5\%, 65.4\%]$ | $[47.3\%, 68.6\%]$ | 49.8% | **Indistinguible por Bonferroni 🟡** |

> 💡 **Conclusión Direccional**: Al corregir formalmente por comparaciones múltiples ($k=10$), el intervalo de confianza al $99.5\%$ de **todos los umbrales (incluyendo $3.0\%$) cruza el punto de equilibrio**. Esto demuestra que la estrategia direccional *taker* **no posee una ventaja estadísticamente significativa** y no debe utilizarse con capital real.

![Figura 1: Barrido Empírico con IC Bonferroni](./plots/fig1_equity_curve.png)

---

## ⚡ Estrategia del Creador de Mercado Autónomo (Market Maker)

La estrategia **Market Maker** actúa como **proveedor autónomo de liquidez**, capturando el diferencial (*bid-ask spread*) mediante órdenes límite con control dinámico de inventario.

### 1. Desglose del Modelo de Fricción (18%)
- **8% Latencia de Relayer Polygon**: Retraso en ejecución de $\sim 120\text{ms}$.
- **7% Deslice de Mercado (Slippage)**: Descuento de $\$0.005$ USD por contrato.
- **3% Gas Fees**: Costo por rebalanceo de inventario en lote.

### 2. Resultados Empíricos del Market Maker con IC Bootstrap

| Métrica del Market Maker | Rendimiento Bruto | Rendimiento Neto (Fricción 18%) | IC 95% Bootstrap (PnL Neto) |
| :--- | :---: | :---: | :---: |
| **Ganancia Total Acumulada** | **+\$5,431.00 USD** | **+\$4,453.42 USD** | **$[+\$4,378.96, \; +\$4,530.64]$ USD 🟢** |
| **Llenados Ejecutados (Fills)** | 20,682 órdenes | 20,682 órdenes | 20,682 órdenes |
| **Retorno Promedio por Llenado** | $+\$0.262$ USD / fill | $+\$0.215$ USD / fill | — |

![Figura 4: Control Dinámico de Inventario](./plots/fig4_inventory_skew.png)

---

## 💻 Instalación y Ejecución del Backtest

```bash
# 1. Clonar repositorio
git clone https://github.com/mario89torres/pmbtc-quant.git
cd pmbtc-quant

# 2. Correr la auditoría empírica rigurosa con Bonferroni e IC Bootstrap
node run_full_rigorous_backtest.js

# 3. Regenerar gráficas empíricas reales (AUC Real = 0.8572)
python generate_honest_plots.py
```

---

## 🎓 Whitepaper Técnico y Estudio de Caso

- 🇲🇽 **[Whitepaper en Español (PDF)](./research_paper_es.pdf)** | **[Código LaTeX (.tex)](./research_paper_es.tex)**
- 🇬🇧 **[Whitepaper en Inglés (PDF)](./research_paper_en.pdf)** | **[Código LaTeX (.tex)](./research_paper_en.tex)**
- 📖 **[Documentación Técnica (Markdown)](./technical_documentation.md)**

---

## ⚠️ Descargo de Responsabilidad de Riesgo
Este repositorio es un whitepaper técnico y estudio de caso algorítmico. No constituye asesoramiento financiero. Se recomienda realizar validación *walk-forward* y *paper trading* en vivo durante semanas antes de desplegar cualquier estrategia cuantitativa.

---
**Repositorio**: [github.com/mario89torres/pmbtc-quant](https://github.com/mario89torres/pmbtc-quant)
