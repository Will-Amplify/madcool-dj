# MadCool DJ — Design Spec

**Date:** 2026-07-18  
**Status:** Approved  
**Host:** Tom (Intel i5-3210M, 4 threads, ~16GB RAM, no GPU) · PipeWire · SXW-MDL7601  
**Repo:** `/home/madcoolseed/Projects/madcool-dj`  
**Test audio:** `/home/madcoolseed/Music` (long WAVs; demo uses cropped clips)

## Decisions locked

| Topic | Choice |
|-------|--------|
| Scope | Full-stack parallel cradles; thin vertical path through local files |
| Output | PipeWire → in-use sink (SXW-MDL7601 Digital Stereo IEC958); preempt Rhythmbox when engine claims device |
| Control | HTTP + WebSocket + MCP sharing one command bus; Tailscale-reachable bind on `tom-1` (`100.85.196.90`) |
| Sources | Local files real; Roon control real (Core on **Simon**, Tailscale `100.109.124.125`, ports 9330/55000 open); Spotify/Tidal stubs with stable interfaces |
| Autopilot | Full auto — select, cue, beatmatch, crossfade, light FX; human or agent override anytime |
| Architecture | Dual process: `dj-engine` (Python) + `dj-control` (TypeScript) |

## Architecture

```
Browser dashboard  ←── WS/HTTP ──→  dj-control (Node/TS)
                                         │  MCP tools
                                         │  Roon extension → Simon
                                         │  Spotify/Tidal stubs
                                         ▼
                                   Unix socket (primary) / localhost fallback
                                         │
                                   dj-engine (Python)
                                         │  analyze · cache · dual-deck · FX
                                         ▼
                                   PipeWire → SXW-MDL7601
```

### `dj-engine` (Python 3.12+ venv)

Responsibilities:

- Dual-deck PCM mixer outputting via `sounddevice` (PipeWire)
- Equal-power crossfade, per-deck gain, 3-band EQ, light FX (low-pass/high-pass, short delay)
- Autopilot planner: candidate scoring from analysis cache; transition planned before the cut
- Single nice’d analysis worker: BPM/beat grid, energy envelope, five spectral bands, optional AcoustID on first ~120s
- Disk cache: `~/.cache/madcool-dj/analysis/` keyed by `sha1(path) + mtime_ns + analyzer_version`
- Engine protocol server on Unix socket `$XDG_RUNTIME_DIR/madcool-dj.sock` (JSON lines request/response + event push)

Non-responsibilities: HTTP, MCP, Roon, dashboard HTML.

### `dj-control` (TypeScript / Node 22)

Responsibilities:

- HTTP API (Hono) + WebSocket live state fan-out
- Serve dashboard static assets
- MCP stdio/HTTP adapter → same command bus as REST
- Roon client via `node-roon-api` targeting Simon (Tailscale first, LAN discovery fallback)
- Spotify and Tidal stub connectors implementing `SourceConnector` (`search`, `resolve`, `getStream` → `NotConfiguredError`)
- Auth: `DJ_TOKEN` bearer required when bind address is non-loopback

Non-responsibilities: realtime DSP, PipeWire device ownership.

### Process supervision

`scripts/dev.sh` starts engine then control. Optional systemd user units later. Engine crash → control surfaces `engine.disconnected`; control crash → audio keeps playing until engine idle timeout policy (v1: keep playing last plan).

## Gentle resource policy (Tom)

1. No GPU paths. No Demucs or stem ML. “Instrument mix” = spectral band energies: sub (&lt;60Hz), bass (60–250), low-mid (250–2k), high-mid (2k–6k), hats (&gt;6k).
2. Analysis at 22050 Hz mono via ffmpeg; chunked reads; never load full 400MB WAVs into RAM.
3. AcoustID/`fpcalc` only on the first ~120 seconds when `ACOUSTID_API_KEY` is set; otherwise skip ID silently.
4. One analysis job at a time; `os.nice(10)` on worker.
5. Realtime audio callback: mix PCM + EQ + crossfade only. All planning off-callback.
6. Long DJ mixes: store beat/energy timeline; demo path crops 90s fixtures under `fixtures/clips/` with ffmpeg so first cook doesn’t wait on 40-minute analyzes.
7. Default sample rate for mix bus: 44100 stereo (match source files / DAC).

## Command bus

Canonical commands (REST `POST /v1/cmd`, MCP tools, engine socket):

| Command | Role |
|---------|------|
| `status` | Engine + control health, sink name, autopilot flag |
| `library.scan` | Index `MUSIC_ROOT` (default `~/Music`) |
| `library.list` | Cached tracks + analysis summary |
| `analyze.file` | Queue analysis for path |
| `deck.load` | `{deck: "a"\|"b", path, startSec?}` |
| `deck.play` / `deck.pause` | Transport |
| `mixer.crossfade` | `{position: 0..1}` or `{to: "a"\|"b", bars?}` |
| `fx.set` | `{deck?, filter?, delay?, eq?}` |
| `autopilot.enable` / `autopilot.disable` | Full auto |
| `roon.zones` | List zones from Simon |
| `roon.control` | `{zone, action: play\|pause\|next\|…}` |
| `device.claim` | Stop conflicting clients; open SXW sink |

Live events (WS + engine push): `decks`, `levels`, `plan`, `waveform`, `bands`, `fx`, `log`, `engine`.

## Data flow — autopilot transition

1. Deck A playing; when remaining time &lt; plan horizon (default 32 bars or 45s), planner queries cache for candidates: BPM within ±6%, energy continuity, not in recent play list.
2. Load winner on Deck B at chosen cue; compute tempo ratio (clamp ±3% for gentle pitch); schedule equal-power crossfade.
3. Emit `plan` + continuous `levels`/`bands`.
4. On complete, Deck B becomes A; clear opposite deck; repeat.
5. Override: any `mixer.*` / `deck.*` / `autopilot.disable` cancels pending plan.

Roon is catalog/zone co-pilot only. Mix bus never routes through Roon in v1 (avoids DAC contention with SXW).

## Dashboard

Single HTML/JS app (Vite + vanilla or lightweight Preact):

- Dual deck meters, titles, BPM, waveform overview (low-res from cache)
- Crossfader + EQ/FX knobs
- Upcoming plan card
- Agent activity log
- Connection badge (engine / Roon / Tailscale bind)

Visual direction: dark control-surface, teal accents for live meters (literal “teal time”), no purple-gradient AI chrome.

## Error handling

| Failure | Behavior |
|---------|----------|
| Sink busy | `device.claim` stops Rhythmbox/known players; retry once; else error event |
| Roon down | `roon.*` returns `RoonUnavailable`; mix continues |
| Analyze fail | Track playable metadata-only; autopilot uses volume crossfade fallback |
| Engine socket down | Control marks disconnected; commands that need engine fail explicitly |
| Missing AcoustID key | Skip identification; no error spam |

## Security

- Default bind `127.0.0.1`. Tailscale/remote requires `--host 0.0.0.0` + `DJ_TOKEN`.
- No secrets in repo; `.env` gitignored. Roon token file under `~/.config/madcool-dj/roon_token`.

## Testing

1. Unit: crossfade curves, cache keys, command parsing, candidate scorer.
2. Integration: two fixture clips → audible mix on SXW (or null sink in CI).
3. Agent: HTTP/MCP `autopilot.enable` + WS event assertions.
4. Roon smoke: `roon.zones` against Simon after one-time extension approve.

## Out of scope (v1 cradles only)

- Spotify/Tidal PCM into the mixer
- Stem separation
- Using Roon as the mix output device
- Cloud / remote ML inference
- Multi-user accounts

## Repo layout (target)

```
madcool-dj/
  docs/superpowers/specs/
  docs/superpowers/plans/
  engine/                 # Python package madcool_dj_engine
  control/                # TypeScript package
  dashboard/              # Vite frontend (or control/public)
  fixtures/clips/         # Short WAV excerpts for demo
  scripts/dev.sh
  scripts/make-fixtures.sh
  .env.example
  README.md
```
