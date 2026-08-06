# ⚡ pmbtc-quant: Marco Cuantitativo de Predicción y Market Making Autónomo para Bitcoin en Polymarket

[![Licencia](https://img.shields.io/badge/License-MIT-brightgreen.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Empírico](https://img.shields.io/badge/Backtest-405_Velas_Reales-orange.svg)](./backtest.js)
[![Academia](https://img.shields.io/badge/Paper-PDF_Emp%C3%ADrico-purple.svg)](./research_paper_es.pdf)

**`pmbtc-quant`** es un marco cuantitativo de alta frecuencia diseñado para el análisis probabilístico, predicción binaria y provisión autónoma de liquidez en opciones binarias de resolución a 15 minutos de Bitcoin (BTC/USD) en mercados de predicción descentralizados (**Polymarket**).

---

## 📑 Tabla de Contenidos
- [Resultados Empíricos Honestos (Base SQLite `pmbtc.db`)](#-resultados-empíricos-honestos-base-sqlite-pmbtcdb)
- [⚡ Estrategia del Creador de Mercado Autónomo (Market Maker / Maker Player)](#-estrategia-del-creador-de-mercado-autónomo-market-maker--maker-player)
- [Modelos Predictivos y Control de Riesgo](#modelos-predictivos-y-control-de-riesgo)
- [Instalación y Ejecución del Backtest](#instalación-y-ejecución-del-backtest)
- [Investigación Académica (Research Paper)](#investigación-académica-research-paper)

---

## 📊 Resultados Empíricos Honestos (Base SQLite `pmbtc.db`)

Para garantizar total transparencia científica, el sistema incluye el script **[`backtest.js`](./backtest.js)** que evalúa el modelo directamente sobre los datos reales registrados en la base de datos SQLite (`pmbtc.db`): **405 velas de 15 minutos resueltas (186,518 muestras de ticks)**.

### 1. Estrategia Direccional (*Taker*): Barrido de Umbrales de Ventaja (Edge)

| Umbral (Edge) | Ops | Aciertos | Tasa de Acierto (%) | IC 95% (Wilson) | Equilibrio (Eq%) | Veredicto Estadístico |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **0.1c (0.1%)** | 404 | 220 | 54.5% | $[49.6\%, 59.2\%]$ | 51.1% | Indistinguible del azar (Cruza Eq) |
| **0.5c (0.5%)** | 395 | 199 | 50.4% | $[45.5\%, 55.3\%]$ | 50.5% | Indistinguible del azar (Cruza Eq) |
| **1.0c (1.0%)** | 355 | 190 | 53.5% | $[48.3\%, 58.6\%]$ | 51.1% | Indistinguible del azar (Cruza Eq) |
| **1.5c (1.5%)** | 313 | 160 | 51.1% | $[45.6\%, 56.6\%]$ | 50.2% | Indistinguible del azar (Cruza Eq) |
| **2.0c (2.0%)** | 264 | 141 | 53.4% | $[47.4\%, 59.3\%]$ | 50.7% | Indistinguible del azar (Cruza Eq) |
| **3.0c (3.0%)** | **169** | **98** | **58.0%** | **$[50.5\%, 65.2\%]$** | **49.8%** | **GANA (IC > Equilibrio) 🟢** |

> 💡 **Conclusión Direccional**: En umbrales bajos ($\le 2.0\%$), el intervalo de confianza cruza el corte de equilibrio de precio pagado (haciendo la señal indistinguible del azar). **Únicamente al exigir una ventaja de 3.0c (3.0%)**, el modelo aísla 169 oportunidades donde la tasa de acierto del **58.0%** sostiene un intervalo de confianza que queda estrictamente por encima del equilibrio ($49.8\%$).

![Figura 1: Barrido Empírico de Umbrales](./plots/fig1_equity_curve.png)

---

## ⚡ Estrategia del Creador de Mercado Autónomo (Market Maker / Maker Player)

A diferencia de adivinar la dirección del precio, la estrategia **Market Maker** opera como **proveedor autónomo de liquidez**, capturando el diferencial (*bid-ask spread*) mediante órdenes límite.

### 1. Algoritmo de Control de Inventario (Inventory Skewing)
$$\text{Skew} = \text{clamp}\left( -0.04, \; 0.04, \; \frac{\text{Inventario}}{50} \times 0.05 \right)$$

![Figura 4: Control Dinámico de Inventario](./plots/fig4_inventory_skew.png)

### 2. Resultados Empíricos del Market Maker (405 Velas Reales)

| Métrica del Market Maker | Rendimiento Bruto | Rendimiento Neto (Con 18% Slippage/Latencia) |
| :--- | :---: | :---: |
| **Ganancia Total Acumulada** | **+\$5,403.20 USD** | **+\$4,430.62 USD 🟢** |
| **Llenados Ejecutados (Fills)** | 20,662 órdenes | 20,662 órdenes |
| **Retorno Promedio por Llenado** | $+\$0.261$ USD / fill | $+\$0.214$ USD / fill |

---

## 💻 Instalación y Ejecución del Backtest

```bash
# 1. Clonar repositorio
git clone https://github.com/mario89torres/pmbtc-quant.git
cd pmbtc-quant

# 2. Correr el backtest empírico 100% real sobre SQLite
node backtest.js

# 3. Iniciar el servidor local de monitoreo
node server.js
```

---

## 🎓 Investigación Académica (Research Paper)

- 🇲🇽 **[Research Paper en Español (PDF)](./research_paper_es.pdf)** | **[Código LaTeX (.tex)](./research_paper_es.tex)**
- 🇬🇧 **[Research Paper en Inglés (PDF)](./research_paper_en.pdf)** | **[Código LaTeX (.tex)](./research_paper_en.tex)**
- 📖 **[Documentación Técnica (Markdown)](./technical_documentation.md)**

---

## ⚠️ Descargo de Responsabilidad
Este repositorio es para fines de investigación cuantitativa y prueba de concepto algorítmica. El comercio en mercados de predicción implica riesgo de pérdida de capital.

---
**Repositorio**: [github.com/mario89torres/pmbtc-quant](https://github.com/mario89torres/pmbtc-quant)
