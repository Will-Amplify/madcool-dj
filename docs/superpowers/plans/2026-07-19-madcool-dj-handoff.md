# MadCool DJ — handoff notes (2026-07-19)

Fast path for the next agent / Will on Tom.

## Stack

```bash
cd ~/Projects/madcool-dj
./scripts/verify.sh          # full gate: pytest + builds + smokes + e2e
./scripts/dev.sh             # http://127.0.0.1:8787/  (or DJ_HOST)
```

- **Engine** (Python): mix bus, decks, studio (synth/seq/FX/sampler), library, path jail
- **Control** (TS/Hono `:8787`): HTTP/WS/MCP, Roon, MiniMax music gen, auth
- **Audio**: `DJ_AUDIO_MODE=shared` → PipeWire Default Sink (coexist with Roon)
- **Roon**: Simon `100.109.124.125` — zone transport only, not PCM into decks

## Auth (professional gate)

- Non-loopback `DJ_HOST` **requires** non-empty `DJ_TOKEN` (control refuses to boot otherwise).
- Loopback may run without a token (e2e does this).
- Put token in dashboard “token” field (persists + rebinds WS).

## What shipped (flesh-out 2026-07-19 pm)

| Area | Flesh |
|------|--------|
| Live meters | `levels` WS @ ~15 Hz + mixer-core VU (L/R/A/B) |
| Autopilot | Beatmatch ±3%, intro cue from beats/energy, cancelable ramp |
| Crossfade | `mixer.crossfade {to, bars\|seconds}` ramp API |
| EQ | Stateful one-pole via scipy (flat = bypass) |
| Plan UI | Structured card (rate/cue/ramp), not raw JSON |
| Keyboard | A/B focus · Space play · ←/→ xfade · Q cue |
| Index | `library.scan {analyze:true, analyzeLimit?}` fills cache |
| systemd | `scripts/systemd/*.service` user units cradle |

## Verify cradle

```bash
./scripts/verify.sh
# 56 pytest · control/dashboard build · auth/sources/roon/mcp smokes · e2e PASS
```

Control-only: `cd control && npm run smoke`

## MiniMax

- Key: `MINIMAX_API_KEY` in `.env` **or** `~/MiniMax API.txt` (auto-load; do not commit)
- API: `https://api.minimax.io/v1/music_generation` model `music-3.0`
- Cmds: `music.status` | `music.previewPrompt` | `music.analyzeRef` | `music.lyrics` | `music.generate` | `music.job` | `music.jobs`

## Pitfalls

- Don’t `pkill -f` patterns that match the shell command line
- Shared mode needs Roon RAAT on `plug:pipewire` (`./scripts/roon-audio-mode.sh shared`)
- `dashboard/dist` is gitignored — `dev.sh` / `npm run build` before serving
- Path jail: only MUSIC_ROOT, repo `fixtures/`, `~/.cache/madcool-dj`, `~/Music/dj-library` (+ `MADCOOL_DJ_EXTRA_ROOTS`)
- Generated MiniMax URLs expire ~24h — we download immediately

## Repo

- Remote: `https://github.com/Will-Amplify/madcool-dj`
- Branch: `master`
