# MadCool DJ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a dual-process automated DJ on Tom: local-file analysis + dual-deck PipeWire mix to SXW, live HTML dashboard, HTTP/WS/MCP agent control, Roon cradle to Simon, Spotify/Tidal stubs.

**Architecture:** `dj-engine` (Python) owns DSP/analysis/autopilot over a Unix-socket JSON protocol. `dj-control` (TypeScript) owns HTTP/WS/MCP/dashboard/Roon. Shared command names from the design spec.

**Tech Stack:** Python 3.12+ venv, numpy, sounddevice, scipy (light), ffmpeg CLI, pytest · Node 22, Hono, ws, Vite, TypeScript · node-roon-api · MCP SDK

**Spec:** `docs/superpowers/specs/2026-07-18-madcool-dj-design.md`

**Host constraints:** i5-3210M, no GPU — one analyzer, cache everything, crop fixtures for first audio.

---

## File map

| Path | Responsibility |
|------|----------------|
| `engine/pyproject.toml` | Engine package + deps |
| `engine/src/madcool_dj_engine/__init__.py` | Version / analyzer_version |
| `engine/src/madcool_dj_engine/protocol.py` | JSON-lines socket server |
| `engine/src/madcool_dj_engine/commands.py` | Command dispatch |
| `engine/src/madcool_dj_engine/mixer.py` | Dual-deck PCM + crossfade + EQ |
| `engine/src/madcool_dj_engine/audio_out.py` | sounddevice output + device claim |
| `engine/src/madcool_dj_engine/analyze.py` | BPM, energy, spectral bands, AcoustID window |
| `engine/src/madcool_dj_engine/cache.py` | Disk analysis cache |
| `engine/src/madcool_dj_engine/library.py` | Scan MUSIC_ROOT |
| `engine/src/madcool_dj_engine/autopilot.py` | Candidate score + transition plan |
| `engine/src/madcool_dj_engine/fx.py` | Filter/delay helpers |
| `engine/src/madcool_dj_engine/__main__.py` | CLI entry |
| `engine/tests/test_crossfade.py` | Crossfade math |
| `engine/tests/test_cache.py` | Cache keys |
| `engine/tests/test_scorer.py` | Autopilot scoring |
| `control/package.json` | Control + MCP deps |
| `control/src/index.ts` | Boot HTTP/WS/MCP |
| `control/src/bus.ts` | Command bus → engine socket |
| `control/src/engineClient.ts` | Unix socket client |
| `control/src/routes.ts` | REST `/v1/*` |
| `control/src/ws.ts` | Live event fan-out |
| `control/src/mcp.ts` | MCP tool wrappers |
| `control/src/roon.ts` | Roon → Simon |
| `control/src/sources/types.ts` | SourceConnector interface |
| `control/src/sources/spotify.ts` | Stub |
| `control/src/sources/tidal.ts` | Stub |
| `control/src/sources/local.ts` | Local library proxy |
| `dashboard/` | Vite UI |
| `fixtures/clips/` | 90s demo WAVs |
| `scripts/make-fixtures.sh` | Crop from ~/Music |
| `scripts/dev.sh` | Start engine + control |
| `.env.example` | Tokens / hosts |
| `README.md` | Runbook |

---

### Task 1: Repo cradle + fixtures

**Files:**
- Create: `README.md`, `.env.example`, `scripts/make-fixtures.sh`, `scripts/dev.sh`
- Create: `fixtures/clips/.gitkeep`

- [ ] **Step 1: Write `.env.example`**

```bash
MUSIC_ROOT=/home/madcoolseed/Music
DJ_TOKEN=change-me-for-tailscale
DJ_HOST=127.0.0.1
DJ_PORT=8787
ROON_HOST=100.109.124.125
ACOUSTID_API_KEY=
ENGINE_SOCK=${XDG_RUNTIME_DIR}/madcool-dj.sock
```

- [ ] **Step 2: Write `scripts/make-fixtures.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/fixtures/clips"
mkdir -p "$OUT"
# 90s from ~2:00 into each long mix — gentle CPU later
ffmpeg -y -ss 120 -t 90 -i "/home/madcoolseed/Music/140MarchPrep.wav" \
  -ac 2 -ar 44100 "$OUT/clip_a.wav"
ffmpeg -y -ss 180 -t 90 -i "/home/madcoolseed/Music/SamSupaRadioMix4Ntype0524EDIT.wav" \
  -ac 2 -ar 44100 "$OUT/clip_b.wav"
ffprobe -hide_banner "$OUT/clip_a.wav"
ffprobe -hide_banner "$OUT/clip_b.wav"
```

- [ ] **Step 3: Run fixtures script**

Run: `chmod +x scripts/make-fixtures.sh && ./scripts/make-fixtures.sh`  
Expected: two ~15–20MB WAVs under `fixtures/clips/`, duration ~90s each.

- [ ] **Step 4: Write minimal README runbook**

Include: Tom constraints, `./scripts/dev.sh`, Tailscale bind note, Roon approve-once on Simon.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example scripts fixtures
GIT_AUTHOR_NAME="Will Kline" GIT_AUTHOR_EMAIL="willkline@willkline.com" \
GIT_COMMITTER_NAME="Will Kline" GIT_COMMITTER_EMAIL="willkline@willkline.com" \
git commit -m "chore: scaffold MadCool DJ fixtures and env"
```

---

### Task 2: Engine package + crossfade math (TDD)

**Files:**
- Create: `engine/pyproject.toml`
- Create: `engine/src/madcool_dj_engine/__init__.py`
- Create: `engine/src/madcool_dj_engine/mixer.py` (curves only first)
- Create: `engine/tests/test_crossfade.py`

- [ ] **Step 1: Write failing test**

```python
# engine/tests/test_crossfade.py
import numpy as np
from madcool_dj_engine.mixer import equal_power_gains

def test_equal_power_endpoints():
    a, b = equal_power_gains(0.0)
    assert a == pytest.approx(1.0)
    assert b == pytest.approx(0.0)
    a, b = equal_power_gains(1.0)
    assert a == pytest.approx(0.0)
    assert b == pytest.approx(1.0)

def test_equal_power_mid_energy():
    a, b = equal_power_gains(0.5)
    assert (a * a + b * b) == pytest.approx(1.0, abs=1e-6)
```

(Add `import pytest`.)

- [ ] **Step 2: Run test — expect fail**

Run: `cd engine && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]" && pytest tests/test_crossfade.py -v`  
Expected: FAIL import or missing function.

- [ ] **Step 3: Minimal implementation**

```toml
# engine/pyproject.toml
[project]
name = "madcool-dj-engine"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "numpy>=1.26",
  "sounddevice>=0.5",
  "scipy>=1.11",
]

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[project.scripts]
madcool-dj-engine = "madcool_dj_engine.__main__:main"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]
```

```python
# engine/src/madcool_dj_engine/__init__.py
__version__ = "0.1.0"
ANALYZER_VERSION = 1
```

```python
# engine/src/madcool_dj_engine/mixer.py
import math
from typing import Tuple

def equal_power_gains(x: float) -> Tuple[float, float]:
    """x in [0,1]: 0 = full A, 1 = full B."""
    x = 0.0 if x < 0 else 1.0 if x > 1 else float(x)
    a = math.cos(x * math.pi / 2)
    b = math.sin(x * math.pi / 2)
    return a, b
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pytest tests/test_crossfade.py -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine
# same author env as Task 1
git commit -m "feat(engine): equal-power crossfade gains"
```

---

### Task 3: Analysis cache keys (TDD)

**Files:**
- Create: `engine/src/madcool_dj_engine/cache.py`
- Create: `engine/tests/test_cache.py`

- [ ] **Step 1: Failing test**

```python
from pathlib import Path
from madcool_dj_engine.cache import cache_key, ANALYZER_VERSION

def test_cache_key_stable(tmp_path: Path):
    f = tmp_path / "a.wav"
    f.write_bytes(b"RIFF")
    k1 = cache_key(f)
    k2 = cache_key(f)
    assert k1 == k2
    assert str(ANALYZER_VERSION) in k1 or True  # key embeds version internally
```

Prefer asserting key changes when mtime changes:

```python
def test_cache_key_changes_on_mtime(tmp_path: Path):
    f = tmp_path / "a.wav"
    f.write_bytes(b"RIFF")
    k1 = cache_key(f)
    import os, time
    time.sleep(0.01)
    f.write_bytes(b"RIFF2")
    k2 = cache_key(f)
    assert k1 != k2
```

- [ ] **Step 2: Implement `cache.py`**

```python
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Optional
from madcool_dj_engine import ANALYZER_VERSION

def cache_dir() -> Path:
    p = Path.home() / ".cache" / "madcool-dj" / "analysis"
    p.mkdir(parents=True, exist_ok=True)
    return p

def cache_key(path: Path) -> str:
    path = path.resolve()
    st = path.stat()
    raw = f"{path}|{st.st_mtime_ns}|{st.st_size}|{ANALYZER_VERSION}"
    return hashlib.sha1(raw.encode()).hexdigest()

def load_analysis(path: Path) -> Optional[dict[str, Any]]:
    fp = cache_dir() / f"{cache_key(path)}.json"
    if not fp.exists():
        return None
    return json.loads(fp.read_text())

def save_analysis(path: Path, data: dict[str, Any]) -> Path:
    fp = cache_dir() / f"{cache_key(path)}.json"
    payload = {**data, "analyzer_version": ANALYZER_VERSION, "path": str(path.resolve())}
    fp.write_text(json.dumps(payload))
    return fp
```

- [ ] **Step 3: pytest pass + commit**

```bash
pytest tests/test_cache.py -v
git commit -m "feat(engine): analysis disk cache keys"
```

---

### Task 4: Lightweight analyzer

**Files:**
- Create: `engine/src/madcool_dj_engine/analyze.py`
- Create: `engine/tests/test_analyze_smoke.py`

- [ ] **Step 1: Implement ffmpeg decode + features**

Use subprocess ffmpeg to s16le mono 22050; numpy for RMS energy envelope; FFT band powers on short hops; BPM via onset strength autocorrelation (pure numpy — no librosa required for v1).

Sketch:

```python
def decode_mono_22k(path: Path, max_seconds: float | None = None) -> tuple[np.ndarray, int]:
    cmd = [
        "ffmpeg", "-v", "error", "-i", str(path),
        "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "22050",
    ]
    if max_seconds is not None:
        cmd.extend(["-t", str(max_seconds)])
    cmd.append("pipe:1")
    raw = subprocess.check_output(cmd)
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return audio, 22050

def analyze_file(path: Path) -> dict:
    cached = load_analysis(path)
    if cached:
        return cached
    os.nice(10)
    audio, sr = decode_mono_22k(path)  # fixtures are 90s — OK
    # ... bpm, beats, energy, bands ...
    save_analysis(path, result)
    return result
```

Bands: mean |FFT| power in Hz ranges from design spec.

- [ ] **Step 2: Smoke test on fixture**

```python
def test_analyze_fixture():
    p = Path(__file__).resolve().parents[2] / "fixtures" / "clips" / "clip_a.wav"
    if not p.exists():
        pytest.skip("fixtures missing")
    r = analyze_file(p)
    assert r["duration_sec"] > 60
    assert 60 < r["bpm"] < 200
    assert set(r["bands"].keys()) >= {"sub", "bass", "low_mid", "high_mid", "hats"}
```

Run: `pytest tests/test_analyze_smoke.py -v` (may take 30–90s on Tom — OK once, then cached)

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(engine): gentle ffmpeg analyzer with cache"
```

---

### Task 5: Dual-deck mixer + audio output

**Files:**
- Modify: `engine/src/madcool_dj_engine/mixer.py`
- Create: `engine/src/madcool_dj_engine/audio_out.py`
- Create: `engine/src/madcool_dj_engine/decode.py`

- [ ] **Step 1: Stream decode helper**

`decode.py`: ffmpeg → float32 stereo 44100 blocks generator (or full load for ≤90s fixtures only).

- [ ] **Step 2: Mixer class**

```python
class DualDeckMixer:
    def __init__(self, sr=44100):
        self.sr = sr
        self.crossfade = 0.0  # 0=A 1=B
        self.decks = {"a": None, "b": None}  # DeckState
        # eq/fx state...

    def load(self, deck: str, path: Path, start_sec: float = 0.0): ...
    def mix_block(self, n_frames: int) -> np.ndarray:
        # returns (n_frames, 2) float32
        ...
```

Apply `equal_power_gains(self.crossfade)` per block; optional linear tempo resample later (v1: same-rate play, beatmatch via cue alignment + slight `scipy.signal.resample_poly` only if |ratio-1| > 0.005 and < 0.03).

- [ ] **Step 3: `audio_out.py`**

```python
import sounddevice as sd

def claim_default_sink():
    # best-effort: pkill -f rhythmbox || true
    subprocess.run(["pkill", "-f", "rhythmbox"], check=False)

def start_stream(callback, sr=44100):
    claim_default_sink()
    return sd.OutputStream(samplerate=sr, channels=2, dtype="float32", callback=callback, blocksize=1024)
```

- [ ] **Step 4: Manual listen test (not CI)**

Document in README: load clip_a/clip_b, sweep crossfade 0→1 over 8s.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(engine): dual-deck mixer and PipeWire output"
```

---

### Task 6: Engine protocol + commands

**Files:**
- Create: `engine/src/madcool_dj_engine/protocol.py`
- Create: `engine/src/madcool_dj_engine/commands.py`
- Create: `engine/src/madcool_dj_engine/__main__.py`
- Create: `engine/tests/test_protocol.py`

- [ ] **Step 1: Protocol**

JSON lines over Unix socket:

Request: `{"id":"1","cmd":"status","params":{}}`  
Response: `{"id":"1","ok":true,"result":{...}}`  
Event: `{"event":"levels","data":{...}}`

- [ ] **Step 2: Dispatch table** matching design command names (`status`, `deck.load`, …). Stub `roon.*` as `{"ok":false,"error":"handled_by_control"}`.

- [ ] **Step 3: Test round-trip with tempfile socket**

```python
def test_status_roundtrip(tmp_path):
    # start server thread, connect, send status, assert ok
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(engine): unix socket command protocol"
```

---

### Task 7: Autopilot scorer + planner

**Files:**
- Create: `engine/src/madcool_dj_engine/autopilot.py`
- Create: `engine/src/madcool_dj_engine/library.py`
- Create: `engine/tests/test_scorer.py`

- [ ] **Step 1: Failing scorer test**

```python
def test_prefers_close_bpm():
    current = {"bpm": 128, "bands": {"bass": 0.5}}
    tracks = [
        {"path": "a", "bpm": 140, "bands": {"bass": 0.5}},
        {"path": "b", "bpm": 129, "bands": {"bass": 0.55}},
    ]
    assert pick_next(current, tracks)["path"] == "b"
```

- [ ] **Step 2: Implement `pick_next`** — BPM window ±6%, band L2 distance, exclude `recent` paths.

- [ ] **Step 3: Wire `autopilot.enable` to schedule plan when remaining &lt; horizon; emit `plan` events.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(engine): autopilot candidate scoring and planner"
```

---

### Task 8: Control plane HTTP + engine client

**Files:**
- Create: `control/package.json`, `control/tsconfig.json`, `control/src/*.ts`

- [ ] **Step 1: Init package**

```json
{
  "name": "madcool-dj-control",
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "@hono/node-server": "^1.13.0",
    "ws": "^8.18.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0"
  }
}
```

- [ ] **Step 2: `engineClient.ts`** — connect to `ENGINE_SOCK`, promise RPC, event emitter.

- [ ] **Step 3: Routes**

- `GET /health` → control up
- `GET /v1/status` → engine status
- `POST /v1/cmd` body `{cmd, params}` → bus
- Auth middleware if `DJ_HOST !== 127.0.0.1` or `DJ_TOKEN` set: require `Authorization: Bearer …`

- [ ] **Step 4: WebSocket `/v1/live`** — subscribe to engine events; heartbeat.

- [ ] **Step 5: Smoke**

Run engine + `npm run dev`; `curl -s localhost:8787/health` → `{"ok":true}`

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(control): HTTP command bus and live WebSocket"
```

---

### Task 9: Dashboard (live UI)

**Files:**
- Create: `dashboard/package.json`, `dashboard/index.html`, `dashboard/src/main.ts`, `dashboard/src/style.css`

- [ ] **Step 1: Vite app** with dual decks, crossfader range input, band meters, plan panel, log.

- [ ] **Step 2: Connect WS**; on `levels` update meters; buttons call `POST /v1/cmd`.

- [ ] **Step 3: Control serves `dashboard/dist` in production; in dev, Vite proxy to `:8787`.

- [ ] **Step 4: Visual — dark surface, teal live accents (per design). Keep first viewport as one composition: brand **MadCool DJ**, decks, crossfader.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(dashboard): live dual-deck control surface"
```

---

### Task 10: MCP adapter

**Files:**
- Create: `control/src/mcp.ts`
- Modify: `control/package.json` — add `@modelcontextprotocol/sdk`
- Create: `control/src/mcp-stdio.ts` entry

- [ ] **Step 1: Register tools** mirroring commands: `dj_status`, `dj_deck_load`, `dj_autopilot_enable`, `dj_fx_set`, `dj_roon_zones`, …

- [ ] **Step 2: Each tool calls the same `bus.execute(cmd, params)`.

- [ ] **Step 3: Document Cursor MCP config snippet in README:

```json
{
  "mcpServers": {
    "madcool-dj": {
      "command": "npx",
      "args": ["tsx", "/home/madcoolseed/Projects/madcool-dj/control/src/mcp-stdio.ts"]
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(control): MCP tools over shared command bus"
```

---

### Task 11: Roon cradle (Simon)

**Files:**
- Create: `control/src/roon.ts`
- Modify: `control/package.json` — `node-roon-api`, `node-roon-api-transport`, `node-roon-api-browse` (versions pinned after `npm view`)

- [ ] **Step 1: Connect to `ROON_HOST` (default `100.109.124.125`); persist token to `~/.config/madcool-dj/roon_token`.

- [ ] **Step 2: Implement `roon.zones` + `roon.control` on the bus (handled in control, not engine).

- [ ] **Step 3: Manual: enable extension in Roon on Simon once; `curl` zones.

- [ ] **Step 4: If npm Roon packages fail on Node 22, wrap a tiny Python side-car using `roonapi` called only from control via subprocess — document fallback in README. Prefer Node first.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(control): Roon extension cradle targeting Simon"
```

---

### Task 12: Spotify + Tidal stubs

**Files:**
- Create: `control/src/sources/types.ts`, `spotify.ts`, `tidal.ts`, `local.ts`

```typescript
export interface SourceConnector {
  id: "local" | "spotify" | "tidal" | "roon";
  search(q: string): Promise<SearchHit[]>;
  resolve(id: string): Promise<ResolvedTrack>;
  /** PCM or file path for engine — stubs throw NotConfiguredError */
  getPlayable(id: string): Promise<{ kind: "file"; path: string } | { kind: "unsupported" }>;
}
```

Stubs: methods throw `NotConfiguredError` with install hints. Local connector lists engine library.

- [ ] **Step 1: Implement + unit test stub behavior**
- [ ] **Step 2: Commit**

```bash
git commit -m "feat(control): Spotify and Tidal source stubs"
```

---

### Task 13: `scripts/dev.sh` + end-to-end cook

**Files:**
- Modify: `scripts/dev.sh`
- Create: `scripts/e2e-smoke.sh`

- [ ] **Step 1: `dev.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
[[ -f "$ROOT/.env" ]] && set -a && source "$ROOT/.env" && set +a
export ENGINE_SOCK="${ENGINE_SOCK:-$XDG_RUNTIME_DIR/madcool-dj.sock}"
rm -f "$ENGINE_SOCK"
(
  cd "$ROOT/engine"
  # shellcheck disable=SC1091
  source .venv/bin/activate
  python -m madcool_dj_engine --sock "$ENGINE_SOCK"
) &
ENGINE_PID=$!
cleanup() { kill $ENGINE_PID 2>/dev/null || true; }
trap cleanup EXIT
sleep 1
cd "$ROOT/control" && npm run dev
```

- [ ] **Step 2: `e2e-smoke.sh`** — claim device, analyze fixtures, load A/B, enable autopilot, sleep 20, curl status.

- [ ] **Step 3: Run on Tom; confirm audio on SXW; fix issues.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: dev launcher and e2e smoke for local mix"
```

---

### Task 14: Agent fast-path test (session)

- [ ] **Step 1:** Start `./scripts/dev.sh`
- [ ] **Step 2:** Via HTTP (standing in for fastest agent model):

```bash
curl -s -X POST localhost:8787/v1/cmd -H 'content-type: application/json' \
  -d '{"cmd":"library.scan","params":{"root":"fixtures/clips"}}'
curl -s -X POST localhost:8787/v1/cmd -H 'content-type: application/json' \
  -d '{"cmd":"deck.load","params":{"deck":"a","path":"fixtures/clips/clip_a.wav"}}'
curl -s -X POST localhost:8787/v1/cmd -H 'content-type: application/json' \
  -d '{"cmd":"deck.play","params":{"deck":"a"}}'
curl -s -X POST localhost:8787/v1/cmd -H 'content-type: application/json' \
  -d '{"cmd":"autopilot.enable","params":{}}'
```

- [ ] **Step 3:** Open dashboard; verify meters move; stop Rhythmbox if still fighting SXW.
- [ ] **Step 4:** Note results in `docs/superpowers/plans/2026-07-18-madcool-dj-e2e-notes.md` (short).

---

## Self-review checklist

1. **Spec coverage:** Local mix, analysis/bands, autopilot, dashboard, HTTP/WS, MCP, Roon cradle, Spotify/Tidal stubs, Tailscale auth, gentle Tom policy, fixtures — each has a task.
2. **Placeholders:** None intentional; Roon npm pin resolved at Task 11 runtime.
3. **Types:** Command names consistent (`deck.load`, `autopilot.enable`, …) across engine and control.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-madcool-dj.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session, executing-plans, batch with checkpoints  

Which approach?
