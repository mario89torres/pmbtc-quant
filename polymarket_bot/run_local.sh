#!/usr/bin/env bash
# Levanta el Polymarket Trading Bot en local, de punta a punta.
# Uso:
#   ./run_local.sh
#
# Qué hace, en orden:
#   1. Verifica que exista python3.
#   2. Crea el entorno virtual (venv/) si no existe.
#   3. Instala/actualiza dependencias de requirements.txt.
#   4. Crea .env a partir de .env.example si no existe (no lo sobreescribe
#      si ya lo tienes configurado).
#   5. Arranca el servidor en http://127.0.0.1:8000

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 &>/dev/null; then
  echo "ERROR: no se encontró python3. Instálalo antes de continuar." >&2
  exit 1
fi

if [ ! -d "venv" ]; then
  echo "==> Creando entorno virtual (venv/)..."
  python3 -m venv venv
fi

echo "==> Activando entorno virtual..."
# shellcheck disable=SC1091
source venv/bin/activate

echo "==> Instalando dependencias..."
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

if [ ! -f ".env" ]; then
  echo "==> No hay .env, lo creo a partir de .env.example (modo dry_run por defecto)."
  cp .env.example .env
  echo "    Revísalo si más adelante quieres configurar modo live."
else
  echo "==> Ya existe .env, no lo toco."
fi

echo ""
echo "==> Arrancando el servidor en http://127.0.0.1:8000"
echo "    (Ctrl+C para detenerlo)"
echo ""

# Se ejecuta desde dentro de polymarket_bot/ para que los imports resuelvan bien.
python backend/main.py
