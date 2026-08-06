# Pre-registro del criterio de decisión — pmbtc-quant / polymarket_bot

**Fecha de este documento:** _(completar antes de arrancar el Dry Run)_
**Firmado/completado antes de ver un solo resultado real.** Si se modifica después de tener datos, deja de servir como pre-registro — sería el mismo error de sobreajuste que ya se corrigió en el paper de investigación (ver `research_paper_es.tex`, nota de errata de pseudoreplicación).

---

## 1. Qué se está probando

La estrategia de **Market Maker / grid trading** (`strategy="grid"`) del bot en `polymarket_bot/`, corriendo en modo **Dry Run** contra el libro de órdenes real de Polymarket, sin capital en riesgo.

No se está probando la estrategia direccional (`strategy="trend"`) — el paper ya documentó, tras corrección de Bonferroni, que esa señal no tiene ventaja estadísticamente significativa sobre el azar. No se pasará esa parte a modo real bajo ningún resultado de esta validación.

## 2. Duración

**Mínimo 4 semanas corridas**, sin pausas prolongadas, sin reiniciar el contador si un resultado parcial se ve mal. Empieza a contar desde el primer `poll` registrado en `monitor_log.jsonl` con `is_running: true`.

Motivo: el backtest original cubrió ~4-5 días de mercado (405-407 velas). Cuatro semanas expone la estrategia a más regímenes de volatilidad de BTC de los que el backtest alcanzó a ver.

## 3. Métrica y método

- Snapshots de `/api/bot/status` vía `monitor_bot.py poll`, idealmente cada hora (cron).
- Reporte semanal vía `monitor_bot.py report --weeks 1`.
- Intervalo de confianza al 95% por **bootstrap** sobre el PnL diario (no Wilson — esta estrategia genera PnL continuo por captura de spread, no resultados binarios por vela).

## 4. Criterio de decisión — fijado ANTES de ver resultados

### Para considerar pasar a capital real (Fase 4):
> El IC 95% bootstrap del PnL diario debe quedar **enteramente por encima de cero** en **al menos 3 de las 4 semanas**, evaluando cada semana de forma independiente (no el acumulado de las 4 semanas junto).

### Para abandonar o pausar la validación:
> Si en **2 semanas consecutivas** el IC 95% queda enteramente por debajo de cero (pérdida sostenida, no solo ruido), se detiene la validación y no se pasa a capital real con esta configuración.

### Zona gris (IC cruza el cero):
> Una semana con IC que cruza cero cuenta como **neutral**, ni a favor ni en contra — no se redondea hacia "positiva" para alcanzar el umbral de 3/4.

## 5. Qué NO se permite hacer durante la validación

- No cambiar `spread_pct`, `order_size_usdc` ni la lógica de `bot.py` a mitad de las 4 semanas mirando resultados parciales — invalidaría la validación (es el mismo error que "ajustar el umbral mirando el P&L" que ya señala el comentario en `backtest.js`).
- No extender la ventana retroactivamente si la semana 4 sale mal ("una semana más y seguro se acomoda").
- No usar el resultado de una sola semana particularmente buena para justificar saltarse las otras 3.

## 6. Tamaño de capital si se pasa a Fase 4 (real)

- Órdenes al tamaño mínimo operable (`order_size_usdc = 5.0`, el default del código).
- Tope duro de capital total expuesto: _(completar con una cifra que puedas perder por completo sin impacto financiero real — este documento no la fija, es tu decisión personal)_.
- Stop-loss duro: detener el bot si el drawdown acumulado en real supera _(completar, ej. 15-20%)_ del capital asignado a esta prueba.

## 7. Registro de resultados (completar semana a semana, no editar semanas ya cerradas)

| Semana | Fechas | PnL total semana | IC 95% bootstrap | Veredicto (positiva / negativa / neutral) |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |

**Decisión final tras las 4 semanas:** _(completar solo al terminar, según el criterio de la sección 4 — no antes)_
