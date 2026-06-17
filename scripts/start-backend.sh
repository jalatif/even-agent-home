#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT_DIR/server"
PYTHON="$SERVER_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "Missing backend venv at server/.venv." >&2
  echo "Create it with: cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt" >&2
  exit 1
fi

if ! "$PYTHON" -c "import telethon" >/dev/null 2>&1; then
  echo "Backend venv is missing Telethon." >&2
  echo "Install dependencies with: server/.venv/bin/pip install -r server/requirements-dev.txt" >&2
  exit 1
fi

HOST="0.0.0.0"
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--local" ]]; then
    HOST="127.0.0.1"
  else
    ARGS+=("$arg")
  fi
done

cd "$SERVER_DIR"
exec "$PYTHON" -m uvicorn app.main:app --host "$HOST" --port 8787 "${ARGS[@]}"
