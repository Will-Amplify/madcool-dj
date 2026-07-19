#!/usr/bin/env bash
# End-to-end smoke test: boots an isolated engine + control pair (own socket,
# own port — never touches whatever `./scripts/dev.sh` has running), drives
# the full protocol path through the HTTP command bus, and tears everything
# down on exit. No PortAudio/hardware dependency: exercises the protocol
# surface (load/play/autopilot/status), audio-out is best-effort only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ENGINE_SOCK="${ENGINE_SOCK:-/tmp/madcool-e2e.sock}"
DJ_HOST="${DJ_HOST:-127.0.0.1}"
DJ_PORT="${DJ_PORT:-8799}"
BASE_URL="http://${DJ_HOST}:${DJ_PORT}"

CLIP_A="$ROOT/fixtures/clips/clip_a.wav"
CLIP_B="$ROOT/fixtures/clips/clip_b.wav"

if [[ ! -f "$CLIP_A" || ! -f "$CLIP_B" ]]; then
  echo "FAIL: fixtures missing — run ./scripts/make-fixtures.sh first" >&2
  exit 1
fi

if [[ ! -x "$ROOT/engine/.venv/bin/python" ]]; then
  echo "FAIL: engine venv missing — create with: cd engine && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'" >&2
  exit 1
fi

rm -f "$ENGINE_SOCK"
export ENGINE_SOCK

ENGINE_LOG="$(mktemp /tmp/madcool-e2e-engine.XXXXXX.log)"
CONTROL_LOG="$(mktemp /tmp/madcool-e2e-control.XXXXXX.log)"
ENGINE_PID=""
CONTROL_PID=""
CLEANED_UP=0

cleanup() {
  local status=$?
  [[ "$CLEANED_UP" -eq 1 ]] && return
  CLEANED_UP=1
  # `tsx` respawns itself as a child node process to attach its loader, so a
  # plain `kill $CONTROL_PID` only kills the wrapper and orphans the real
  # server — sweep direct children too, TERM first then KILL after a grace
  # period, for both PIDs.
  for pid in "$CONTROL_PID" "$ENGINE_PID"; do
    [[ -n "$pid" ]] || continue
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 0.5
  for pid in "$CONTROL_PID" "$ENGINE_PID"; do
    [[ -n "$pid" ]] || continue
    pkill -KILL -P "$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
  done
  [[ -n "$CONTROL_PID" ]] && wait "$CONTROL_PID" 2>/dev/null || true
  [[ -n "$ENGINE_PID" ]] && wait "$ENGINE_PID" 2>/dev/null || true
  rm -f "$ENGINE_SOCK"
  if [[ "$status" -ne 0 ]]; then
    echo "--- engine log ($ENGINE_LOG) ---" >&2
    cat "$ENGINE_LOG" >&2 2>/dev/null || true
    echo "--- control log ($CONTROL_LOG) ---" >&2
    cat "$CONTROL_LOG" >&2 2>/dev/null || true
  fi
  rm -f "$ENGINE_LOG" "$CONTROL_LOG"
  exit "$status"
}
trap cleanup EXIT INT TERM

echo "==> starting engine (sock=$ENGINE_SOCK)"
(
  cd "$ROOT/engine"
  source .venv/bin/activate
  if python -c "import sounddevice" 2>/dev/null; then
    exec python -m madcool_dj_engine --sock "$ENGINE_SOCK" --play
  else
    exec python -m madcool_dj_engine --sock "$ENGINE_SOCK"
  fi
) >"$ENGINE_LOG" 2>&1 &
ENGINE_PID=$!

for _ in $(seq 1 50); do
  [[ -S "$ENGINE_SOCK" ]] && break
  sleep 0.2
done
if [[ ! -S "$ENGINE_SOCK" ]]; then
  echo "FAIL: engine socket never appeared" >&2
  exit 1
fi
echo "    engine ready (pid=$ENGINE_PID)"

echo "==> starting control ($BASE_URL)"
(
  cd "$ROOT/control"
  export ENGINE_SOCK DJ_HOST DJ_PORT
  unset DJ_TOKEN
  exec ./node_modules/.bin/tsx src/index.ts
) >"$CONTROL_LOG" 2>&1 &
CONTROL_PID=$!

for _ in $(seq 1 50); do
  curl -fsS --max-time 2 "$BASE_URL/health" >/dev/null 2>&1 && break
  sleep 0.2
done
if ! curl -fsS --max-time 2 "$BASE_URL/health" >/dev/null 2>&1; then
  echo "FAIL: control health check never came up" >&2
  exit 1
fi
echo "    control ready (pid=$CONTROL_PID)"

cmd() {
  local name="$1" params="${2:-}"
  [[ -z "$params" ]] && params="{}"
  curl -fsS --max-time 60 -X POST "$BASE_URL/v1/cmd" \
    -H 'content-type: application/json' \
    -d "{\"cmd\":\"${name}\",\"params\":${params}}"
}

echo
echo "==> health"
HEALTH="$(curl -fsS --max-time 5 "$BASE_URL/health")"
echo "$HEALTH"

echo
echo "==> library.scan (root=$ROOT/fixtures/clips)"
SCAN="$(cmd "library.scan" "{\"root\":\"$ROOT/fixtures/clips\"}")"
echo "$SCAN"

echo
echo "==> analyze.file (clip_a)"
ANALYZE_A="$(cmd "analyze.file" "{\"path\":\"$CLIP_A\"}")"
echo "$ANALYZE_A"

echo
echo "==> analyze.file (clip_b)"
ANALYZE_B="$(cmd "analyze.file" "{\"path\":\"$CLIP_B\"}")"
echo "$ANALYZE_B"

echo
echo "==> deck.load a"
LOAD_A="$(cmd "deck.load" "{\"deck\":\"a\",\"path\":\"$CLIP_A\"}")"
echo "$LOAD_A"

echo
echo "==> deck.load b"
LOAD_B="$(cmd "deck.load" "{\"deck\":\"b\",\"path\":\"$CLIP_B\"}")"
echo "$LOAD_B"

echo
echo "==> deck.play a"
PLAY_A="$(cmd "deck.play" "{\"deck\":\"a\"}")"
echo "$PLAY_A"

echo
echo "==> autopilot.enable"
AUTOPILOT="$(cmd "autopilot.enable")"
echo "$AUTOPILOT"

echo
echo "==> status"
STATUS="$(curl -fsS --max-time 5 "$BASE_URL/v1/status")"
echo "$STATUS"

HEALTH_OK="$(echo "$HEALTH" | jq -r '.ok // false')"
STATUS_OK="$(echo "$STATUS" | jq -r '.ok // false')"
SCAN_COUNT="$(echo "$SCAN" | jq -r '.result.count // 0')"
DECK_A_PATH="$(echo "$STATUS" | jq -r '.result.decks.a.path // "null"')"
DECK_A_PLAYING="$(echo "$STATUS" | jq -r '.result.decks.a.playing // false')"
AUTOPILOT_ON="$(echo "$STATUS" | jq -r '.result.autopilot // false')"

echo
echo "==> library.browse (fixtures)"
BROWSE="$(cmd "library.browse" "{\"path\":\"$ROOT/fixtures/clips\"}")"
echo "$BROWSE"
BROWSE_FILES="$(echo "$BROWSE" | jq -r '.result.files | length')"

echo
echo "==> studio.status"
STUDIO="$(cmd "studio.status")"
echo "$STUDIO" | jq -c '{fx:.result.fx.enabled, pads:(.result.sampler.pads|length)}' 2>/dev/null || echo "$STUDIO"
STUDIO_OK="$(echo "$STUDIO" | jq -r '.ok // false')"

echo
echo "==> music.status (optional key)"
MUSIC="$(cmd "music.status" || true)"
echo "$MUSIC" | head -c 400; echo
MUSIC_OK="$(echo "$MUSIC" | jq -r '.ok // false' 2>/dev/null || echo false)"

echo
echo "=== e2e-smoke summary ==="
echo "health.ok=$HEALTH_OK  status.ok=$STATUS_OK  library.scan.count=$SCAN_COUNT"
echo "deck.a.path=$DECK_A_PATH  deck.a.playing=$DECK_A_PLAYING  autopilot=$AUTOPILOT_ON"
echo "browse.files=$BROWSE_FILES  studio.ok=$STUDIO_OK  music.ok=$MUSIC_OK"

FAILS=0
[[ "$HEALTH_OK" == "true" ]] || { echo "FAIL: health" >&2; FAILS=$((FAILS+1)); }
[[ "$STATUS_OK" == "true" ]] || { echo "FAIL: status" >&2; FAILS=$((FAILS+1)); }
[[ "$SCAN_COUNT" -ge 2 ]] || { echo "FAIL: expected scan count >= 2, got $SCAN_COUNT" >&2; FAILS=$((FAILS+1)); }
[[ "$DECK_A_PATH" == *clip_a.wav ]] || { echo "FAIL: deck A path should end with clip_a.wav" >&2; FAILS=$((FAILS+1)); }
[[ "$DECK_A_PLAYING" == "true" ]] || { echo "FAIL: deck A should be playing" >&2; FAILS=$((FAILS+1)); }
[[ "$AUTOPILOT_ON" == "true" ]] || { echo "FAIL: autopilot should be on" >&2; FAILS=$((FAILS+1)); }
[[ "$BROWSE_FILES" -ge 2 ]] || { echo "FAIL: browse should list >= 2 files" >&2; FAILS=$((FAILS+1)); }
[[ "$STUDIO_OK" == "true" ]] || { echo "FAIL: studio.status" >&2; FAILS=$((FAILS+1)); }

if [[ "$FAILS" -eq 0 ]]; then
  echo "PASS: protocol path + load/play/autopilot/browse/studio"
  exit 0
else
  echo "FAIL: $FAILS assertion(s) failed" >&2
  exit 1
fi
