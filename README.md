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

`dev.sh` builds the dashboard if needed, starts the engine (`--play` when PortAudio/sounddevice is available, protocol-only otherwise), waits for its socket, then runs `dj-control` in the foreground. Ctrl-C tears both down.

## e2e smoke

`./scripts/e2e-smoke.sh` boots its own isolated engine + control pair (own socket at `/tmp/madcool-e2e.sock`, own port at `:8799` by default — never touches whatever `dev.sh` has running) and drives the full protocol path over the HTTP command bus: `health` → `library.scan` (fixtures) → `analyze.file` on both clips → `deck.load` a/b → `deck.play a` → `autopilot.enable` → `status`. It tears both processes down on exit (success, failure, or Ctrl-C) and dumps their logs if anything failed.

```bash
./scripts/make-fixtures.sh   # once, if fixtures/clips is empty
./scripts/e2e-smoke.sh
```

Exits `0` when `health` and `status` both report `ok: true` (the protocol path — no PortAudio/hardware required). Override `ENGINE_SOCK`, `DJ_HOST`, or `DJ_PORT` env vars if `:8799` or the default socket path is taken.

## Tailscale bind

When `DJ_HOST` is not loopback (e.g. serving on tom-1 at `100.85.196.90`), requests must include a valid `DJ_TOKEN`. Set a strong token in `.env` before exposing the control API beyond localhost.

## Roon

Roon Core runs on Simon (`ROON_HOST=100.109.124.125`). `control/src/roon.ts` registers extension **MadCool DJ** (`com.madcool.dj`) via [`node-roon-api`](https://github.com/RoonLabs/node-roon-api) + transport + status.

**First connection:** on Simon → Settings → Extensions → Enable **MadCool DJ**. Token persists at `~/.config/madcool-dj/roon_token` (`0600`).

### Shared audio (Tom + SXW)

MadCool DJ defaults to `DJ_AUDIO_MODE=shared` (PulseAudio **Default Sink** / PipeWire). RoonBridge must also share — exclusive `hw:SXW…` loses the zone when PipeWire holds the DAC.

```bash
./scripts/roon-audio-mode.sh shared     # RAAT → plug:pipewire + software volume
# then restart RoonBridge with XDG_RUNTIME_DIR set for the logged-in user
./scripts/roon-audio-mode.sh exclusive  # restore hw:CARD=SXWMDL7601INTCL,DEV=0
```

Dashboard Roon panel: play/pause/stop/prev/next, seek, volume/mute, shuffle/loop/radio.

Commands: `roon.zones`, `roon.control`, `roon.seek`, `roon.volume`, `roon.mute`, `roon.settings`.

Env: `ROON_HOST`, `ROON_PORT` (9330), `ROON_PAIR_TIMEOUT_MS`, `ROON_TOKEN_PATH`, `DJ_AUDIO_MODE` (`shared`|`exclusive`).

```bash
cd control
npx tsx scripts/roon-smoke.ts
npx tsx scripts/roon-mock-smoke.ts
```

## Fixtures

Run `./scripts/make-fixtures.sh` to slice ~90s WAV clips from source mixes under `MUSIC_ROOT`. Generated `.wav` files stay local (gitignored); only `fixtures/clips/.gitkeep` is tracked.

## Dashboard

`dashboard/` is a dual-deck local mix surface + Roon co-pilot:

- Per deck: play/pause, CUE / SET CUE, jog + scrub, pitch (±8%), HI/MID/LOW EQ, gain, RMS waveform on load
- Center: crossfader, autopilot, claim/release DAC, shared/exclusive audio mode
- Top **Files**: directory browse (`library.browse`), drag-drop onto decks, Index for recursive scan
- Top **Roon**: full zone transport (see above)
- Live WS activity log + upcoming autopilot plan

Mix bus is always local PipeWire. Roon is zone transport on the same shared sink — not PCM into the decks. Spotify/Tidal remain stubs.

```bash
cd dashboard && npm i && npm run build
./scripts/dev.sh
# open http://127.0.0.1:8787/
```

Right-click a file to toggle load target A↔B.

## MCP

`control/src/mcp-stdio.ts` exposes the same command bus (`control/src/bus.ts`) as a set of MCP tools (`dj_status`, `dj_deck_load`, `dj_deck_play`/`dj_deck_pause`, `dj_mixer_crossfade`, `dj_autopilot_enable`/`dj_autopilot_disable`, `dj_fx_set`, `dj_library_scan`/`dj_library_list`, `dj_analyze_file`, `dj_device_claim`, `dj_roon_zones`/`dj_roon_control`) — no separate HTTP server, just stdio framing for an MCP client.

It needs a running engine: set `ENGINE_SOCK` (or `XDG_RUNTIME_DIR`, which the default falls back to) before launching, same as `dj-control`. If the engine isn't up yet, the process still starts and connects the MCP transport — it just logs `engine socket error` / `engine disconnected, will reconnect` to stderr and retries with backoff instead of crashing.

Add to Cursor's MCP config (`~/.cursor/mcp.json` or the project-local equivalent):

```json
{
  "mcpServers": {
    "madcool-dj": {
      "command": "npx",
      "args": ["tsx", "/home/madcoolseed/Projects/madcool-dj/control/src/mcp-stdio.ts"],
      "cwd": "/home/madcoolseed/Projects/madcool-dj/control",
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
