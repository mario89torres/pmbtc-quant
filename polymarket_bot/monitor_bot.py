#!/usr/bin/env python3
"""
monitor_bot.py - Monitoreo de validación forward para el bot de pmbtc-quant.

No usa Wilson CI (eso es para tasas de acierto binarias, tipo "gana/pierde
por vela"). Este bot corre una estrategia de grid market making con PnL
continuo por captura de spread, así que el análisis correcto es un
intervalo de confianza por bootstrap sobre el PnL diario -- el mismo
método que ya usa run_full_rigorous_backtest.js para el Market Maker.

USO:
  1. Registrar un snapshot (llamar seguido, ej. con cron cada hora):
       python3 monitor_bot.py poll

  2. Ver el reporte semanal con IC bootstrap:
       python3 monitor_bot.py report

  3. Programarlo con cron (cada hora, por ejemplo):
       0 * * * *  cd /ruta/a/polymarket_bot && ./venv/bin/python monitor_bot.py poll >> monitor.log 2>&1

Requiere que el servidor esté corriendo en BOT_URL (default: http://127.0.0.1:8000).
No depende de librerías externas, solo librería estándar de Python.
"""

import argparse
import json
import os
import random
import statistics
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "monitor_log.jsonl")
BOT_URL = os.environ.get("PMBTC_BOT_URL", "http://127.0.0.1:8080")


def poll():
    """Toma un snapshot del estado actual del bot y lo agrega al log."""
    url = f"{BOT_URL}/api/bot/status"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            status = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"ERROR: no se pudo conectar a {url}: {e}", file=sys.stderr)
        sys.exit(1)

    snapshot = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "is_running": status.get("is_running", False),
        "usdc_balance": status.get("usdc_balance"),
        "realized_pnl": status.get("realized_pnl"),
        "total_trades": status.get("total_trades"),
    }

    with open(LOG_PATH, "a") as f:
        f.write(json.dumps(snapshot) + "\n")

    print(f"[{snapshot['ts']}] PnL={snapshot['realized_pnl']} trades={snapshot['total_trades']} "
          f"running={snapshot['is_running']}")


def _load_log():
    if not os.path.exists(LOG_PATH):
        return []
    rows = []
    with open(LOG_PATH) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _daily_pnl_deltas(rows):
    """A partir de snapshots crudos, arma la serie de PnL acumulado por día
    y devuelve los deltas día a día (cuánto PnL se generó cada día)."""
    by_day = {}
    for r in rows:
        if r.get("realized_pnl") is None:
            continue
        day = r["ts"][:10]  # YYYY-MM-DD
        # Nos quedamos con el último snapshot de cada día (PnL acumulado al cierre)
        by_day[day] = r["realized_pnl"]

    days_sorted = sorted(by_day.keys())
    deltas = []
    prev_pnl = 0.0
    for day in days_sorted:
        pnl_today = by_day[day]
        deltas.append({"day": day, "pnl_acumulado": pnl_today, "pnl_del_dia": pnl_today - prev_pnl})
        prev_pnl = pnl_today
    return deltas


def _bootstrap_ci(values, n_iter=2000, alpha=0.05, seed=42):
    """IC bootstrap simple sobre la media de una lista de valores."""
    if len(values) < 2:
        return None
    rng = random.Random(seed)
    n = len(values)
    means = []
    for _ in range(n_iter):
        sample = [values[rng.randrange(n)] for _ in range(n)]
        means.append(statistics.fmean(sample))
    means.sort()
    lo_idx = int((alpha / 2) * n_iter)
    hi_idx = int((1 - alpha / 2) * n_iter) - 1
    return {
        "media": statistics.fmean(values),
        "ic_95_lower": means[lo_idx],
        "ic_95_upper": means[hi_idx],
    }


def report(weeks_back=None):
    rows = _load_log()
    if not rows:
        print("No hay datos todavía. Corre 'python3 monitor_bot.py poll' primero "
              "(idealmente varias veces al día, vía cron).")
        return

    deltas = _daily_pnl_deltas(rows)
    if len(deltas) < 2:
        print(f"Solo hay {len(deltas)} día(s) de datos. Se necesitan al menos "
              f"unos días más para que el IC bootstrap tenga sentido.")
        for d in deltas:
            print(f"  {d['day']}: PnL del día = {d['pnl_del_dia']:+.2f} | acumulado = {d['pnl_acumulado']:+.2f}")
        return

    if weeks_back:
        cutoff = (datetime.now(timezone.utc) - timedelta(weeks=weeks_back)).strftime("%Y-%m-%d")
        deltas = [d for d in deltas if d["day"] >= cutoff]

    daily_values = [d["pnl_del_dia"] for d in deltas]
    ci = _bootstrap_ci(daily_values)

    print("=" * 70)
    print(f"REPORTE DE VALIDACIÓN FORWARD  ({len(deltas)} días registrados)")
    print("=" * 70)
    print(f"{'Día':<12} {'PnL del día':>14} {'PnL acumulado':>16}")
    for d in deltas:
        print(f"{d['day']:<12} {d['pnl_del_dia']:>+14.2f} {d['pnl_acumulado']:>+16.2f}")

    print("-" * 70)
    print(f"PnL total del período:         {sum(daily_values):+.2f} USDC")
    print(f"PnL medio diario:               {ci['media']:+.4f} USDC")
    print(f"IC 95% (bootstrap) del promedio diario: [{ci['ic_95_lower']:+.4f}, {ci['ic_95_upper']:+.4f}]")
    print("-" * 70)

    if ci["ic_95_lower"] > 0:
        veredicto = "El IC queda ENTERO por encima de cero: la señal se sostiene esta semana."
    elif ci["ic_95_upper"] < 0:
        veredicto = "El IC queda ENTERO por debajo de cero: PnL negativo, no se distingue de pérdida sostenida."
    else:
        veredicto = "El IC CRUZA el cero: no se distingue de ruido. No cuenta como semana positiva."
    print(f"Veredicto: {veredicto}")
    print("=" * 70)
    print("\nRecuerda el criterio pre-registrado (ver pre_registro_validacion.md):")
    print("solo pasar a capital real si el IC queda por encima de cero en al menos")
    print("3 de las 4 semanas de Dry Run, evaluadas semana a semana, no acumuladas.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Monitoreo de validación forward del bot")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("poll", help="Registra un snapshot del estado actual del bot")
    p_report = sub.add_parser("report", help="Muestra el reporte con IC bootstrap")
    p_report.add_argument("--weeks", type=int, default=None,
                           help="Limitar el reporte a las últimas N semanas (default: todo el historial)")

    args = parser.parse_args()
    if args.cmd == "poll":
        poll()
    elif args.cmd == "report":
        report(weeks_back=args.weeks)
