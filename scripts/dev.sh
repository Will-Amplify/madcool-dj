#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/.env" ]] && set -a && source "$ROOT/.env" && set +a
export ENGINE_SOCK="${ENGINE_SOCK:-${XDG_RUNTIME_DIR:-/tmp}/madcool-dj.sock}"
rm -f "$ENGINE_SOCK"

# Ensure engine venv exists
if [[ ! -x "$ROOT/engine/.venv/bin/python" ]]; then
  echo "engine venv missing — create with: cd engine && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'"
  exit 1
fi

# Build dashboard if missing
if [[ ! -d "$ROOT/dashboard/dist" ]]; then
  (cd "$ROOT/dashboard" && npm run build)
fi

(
  cd "$ROOT/engine"
  source .venv/bin/activate
  # Use --play if PortAudio available; else without --play still serves protocol
  if python -c "import sounddevice" 2>/dev/null; then
    exec python -m madcool_dj_engine --sock "$ENGINE_SOCK" --play
  else
    echo "WARN: sounddevice/PortAudio unavailable — engine protocol only (no audio out)"
    exec python -m madcool_dj_engine --sock "$ENGINE_SOCK"
  fi
) &
ENGINE_PID=$!

cleanup() {
  kill "$ENGINE_PID" 2>/dev/null || true
  wait "$ENGINE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# wait for sock
for i in $(seq 1 30); do
  [[ -S "$ENGINE_SOCK" ]] && break
  sleep 0.2
done
[[ -S "$ENGINE_SOCK" ]] || { echo "engine sock not ready"; exit 1; }

cd "$ROOT/control"
export ENGINE_SOCK
exec npm run dev
