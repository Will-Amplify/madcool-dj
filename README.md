# MadCool DJ

Local dual-process DJ engine: PipeWire mix to SXW DAC, Roon control on Simon.

## Tom constraints

Target machine is **tom-1** (i5-3210M, no GPU). Keep CPU load gentle — prefer fixture clips over full-length mixes during development.

## Quick start

```bash
cp .env.example .env
./scripts/make-fixtures.sh   # once, if clips missing
./scripts/dev.sh
```

`dev.sh` is a stub until engine+control wiring lands (Task 13).

## Tailscale bind

When `DJ_HOST` is not loopback (e.g. serving on tom-1 at `100.85.196.90`), requests must include a valid `DJ_TOKEN`. Set a strong token in `.env` before exposing the control API beyond localhost.

## Roon

Roon Core runs on Simon (`ROON_HOST=100.109.124.125`). `control/src/roon.ts` registers a real Roon extension — "MadCool DJ" (`com.madcool.dj`) — against it using [`node-roon-api`](https://github.com/RoonLabs/node-roon-api) + [`node-roon-api-transport`](https://github.com/RoonLabs/node-roon-api-transport) + [`node-roon-api-status`](https://github.com/RoonLabs/node-roon-api-status), installed straight from GitHub (unpublished on npm) via:

```bash
cd control && npm install github:RoonLabs/node-roon-api github:RoonLabs/node-roon-api-transport github:RoonLabs/node-roon-api-status
```

**First connection requires a one-time approval on Simon**: open Roon -> Settings -> Extensions, find "MadCool DJ" in the list, and click **Enable**. Until then, `roon.zones` / `roon.control` (and the `dj_roon_zones` / `dj_roon_control` MCP tools) fail fast with a `roon_pending_authorization` error instead of hanging or crashing the control server — that's the expected state on a fresh Core, not a bug.

Once approved, Roon hands back a pairing token, which is persisted to `~/.config/madcool-dj/roon_token` (mode `0600`) so future runs reconnect silently without needing to re-approve. Delete that file to force re-pairing.

Env vars (see `.env.example`): `ROON_HOST` (default `100.109.124.125`), `ROON_PORT` (default `9330`, Roon 2.0's extension websocket port — confirmed open on Simon), `ROON_PAIR_TIMEOUT_MS` (default `10000`, how long `roon.zones`/`roon.control` wait for pairing before giving up), `ROON_TOKEN_PATH` (override the token file location).

Smoke scripts:

```bash
cd control
npx tsx scripts/roon-smoke.ts       # real connection to Simon; prints zones or a clear pending-authorization message
npx tsx scripts/roon-mock-smoke.ts  # no network — exercises pending/connected/error paths against a fake RoonApi
```

## Fixtures

Run `./scripts/make-fixtures.sh` to slice ~90s WAV clips from source mixes under `MUSIC_ROOT`. Generated `.wav` files stay local (gitignored); only `fixtures/clips/.gitkeep` is tracked.

## Dashboard

`dashboard/` is a small Vite + vanilla TypeScript control surface: dual decks (title, playing state, position, BPM when cached analysis exists), 5-band meters, a crossfader, an upcoming-plan card, and an agent/activity log fed by every `/v1/live` WebSocket event. Dark charcoal surface, teal live accents — no purple-gradient chrome.

Build it once and `dj-control` serves it automatically:

```bash
cd dashboard && npm i && npm run build
```

`control/src/routes.ts` serves `dashboard/dist` as static files whenever that directory exists (Hono `serveStatic`), so once built, the dashboard is just `http://<control-host>:8787/`. Nothing changes on the control side if you skip the build — the route is a no-op until `dashboard/dist` shows up.

For dashboard-only iteration, `cd dashboard && npm run dev` runs Vite on `:5173` and proxies `/v1/*` (HTTP + WebSocket) to `dj-control` on `:8787`. The dashboard always opens its live WebSocket directly at `ws://<page-host>:8787/v1/live`.

If `DJ_TOKEN` is set, paste it into the dashboard's **token** field (top right) — it's sent as `Authorization: Bearer` on REST calls and as `?token=` on the WebSocket, since browsers can't set custom headers on `new WebSocket(...)`.

## MCP

`control/src/mcp-stdio.ts` exposes the same command bus (`control/src/bus.ts`) as a set of MCP tools (`dj_status`, `dj_deck_load`, `dj_deck_play`/`dj_deck_pause`, `dj_mixer_crossfade`, `dj_autopilot_enable`/`dj_autopilot_disable`, `dj_fx_set`, `dj_library_scan`/`dj_library_list`, `dj_analyze_file`, `dj_device_claim`, `dj_roon_zones`/`dj_roon_control`) — no separate HTTP server, just stdio framing for an MCP client.

It needs a running engine: set `ENGINE_SOCK` (or `XDG_RUNTIME_DIR`, which the default falls back to) before launching, same as `dj-control`. If the engine isn't up yet, the process still starts and connects the MCP transport — it just logs `engine socket error` / `engine disconnected, will reconnect` to stderr and retries with backoff instead of crashing.

Add to Cursor's MCP config (`~/.cursor/mcp.json` or the project-local equivalent):

```json
{
  "mcpServers": {
    "madcool-dj": {
      "command": "npx",
      "args": ["tsx", "/home/madcoolseed/Projects/madcool-dj/.worktrees/madcool-dj-impl/control/src/mcp-stdio.ts"],
      "cwd": "/home/madcoolseed/Projects/madcool-dj/.worktrees/madcool-dj-impl/control",
      "env": {
        "ENGINE_SOCK": "/run/user/1000/madcool-dj.sock"
      }
    }
  }
}
```

`cwd` matters here: it's what makes `npx` find the already-installed `tsx` (and the SDK) in `control/node_modules` instead of trying to hit the registry. Adjust `ENGINE_SOCK` to match wherever the engine actually binds its socket (`echo $XDG_RUNTIME_DIR/madcool-dj.sock` on the host running the engine).

## Listen smoke

Manual check that the mixer actually reaches the SXW DAC on tom-1 (no automated hardware test — `test_mixer_block.py` covers the math without a sound card):

```bash
cd engine && . .venv/bin/activate
python - <<'PY'
import time
from pathlib import Path

from madcool_dj_engine.audio_out import claim_default_sink, start_stream
from madcool_dj_engine.mixer import DualDeckMixer

claim_default_sink()  # best-effort: knock rhythmbox off the default sink

mixer = DualDeckMixer()
mixer.load("a", Path("../fixtures/clips/clip_a.wav"))
mixer.load("b", Path("../fixtures/clips/clip_b.wav"))
mixer.play("a")
mixer.play("b")

stream = start_stream(mixer.mix_block)
try:
    for step in range(11):  # sweep A -> B over ~10s, one step/sec
        mixer.set_crossfade(step / 10)
        print(f"crossfade={mixer.crossfade:.1f}")
        time.sleep(1)
finally:
    stream.stop()
    stream.close()
PY
```

You should hear clip A fade out and clip B fade in as the crossfade sweeps 0 → 1, out of whatever PipeWire treats as the default sink (confirm it's routed to the SXW DAC before trusting your ears).
