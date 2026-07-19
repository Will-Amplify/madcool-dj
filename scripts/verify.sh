#!/usr/bin/env bash
# Professional-grade verify cradle: unit → build → control smokes → e2e.
# Exit non-zero on first failure. Intended for local loop + CI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pass() { echo "✓ $*"; }
fail() { echo "✗ $*" >&2; exit 1; }

echo "=== MadCool DJ verify ==="

# --- Lint / typecheck ---
echo
echo "--> engine ruff"
(
  cd "$ROOT/engine"
  # shellcheck disable=SC1091
  source .venv/bin/activate
  if ! command -v ruff >/dev/null 2>&1; then
    pip install -q 'ruff>=0.8'
  fi
  ruff check src tests
) || fail "engine ruff"
pass "engine ruff"

echo
echo "--> control typecheck"
(cd "$ROOT/control" && npm run typecheck) || fail "control typecheck"
pass "control typecheck"

echo
echo "--> dashboard typecheck"
(cd "$ROOT/dashboard" && npm run typecheck) || fail "dashboard typecheck"
pass "dashboard typecheck"

# --- Engine ---
echo
echo "--> engine pytest"
(
  cd "$ROOT/engine"
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pytest -q
) || fail "engine pytest"
pass "engine pytest"

# --- Builds ---
echo
echo "--> control build"
(cd "$ROOT/control" && npm run build) || fail "control build"
pass "control build"

echo
echo "--> dashboard build"
(cd "$ROOT/dashboard" && npm run build) || fail "dashboard build"
pass "dashboard build"

# --- Control unit smokes (no network to Simon / MiniMax required) ---
echo
echo "--> control auth smoke"
(cd "$ROOT/control" && npx tsx scripts/auth-smoke.ts) || fail "auth smoke"
pass "auth smoke"

echo
echo "--> control sources smoke"
(cd "$ROOT/control" && npx tsx scripts/sources-smoke.ts) || fail "sources smoke"
pass "sources smoke"

echo
echo "--> control roon mock smoke"
(cd "$ROOT/control" && npx tsx scripts/roon-mock-smoke.ts) || fail "roon mock smoke"
pass "roon mock smoke"

echo
echo "--> control mcp smoke"
(cd "$ROOT/control" && npx tsx scripts/mcp-smoke.ts) || fail "mcp smoke"
pass "mcp smoke"

# --- e2e protocol ---
echo
echo "--> e2e-smoke"
"$ROOT/scripts/e2e-smoke.sh" || fail "e2e-smoke"
pass "e2e-smoke"

echo
echo "=== ALL GREEN ==="
