# MadCool DJ — handoff notes (2026-07-19)

Fast path for the next agent / Will on Tom.

## Stack

```bash
cd ~/Projects/madcool-dj
./scripts/dev.sh
# http://127.0.0.1:8787/
```

- **Engine** (Python): mix bus, decks, studio (synth/seq/FX/sampler), library
- **Control** (TS/Hono `:8787`): HTTP/WS/MCP, Roon, MiniMax music gen
- **Audio**: `DJ_AUDIO_MODE=shared` → PipeWire Default Sink (coexist with Roon)
- **Roon**: Simon `100.109.124.125` — zone transport only, not PCM into decks

## What shipped since shared-audio cut

1. **Dubstep studio bus** — pads, wobble synth, 16-step seq, real master FX, transition macros  
2. **Sample library** — procedural kit in `fixtures/dubstep` + `~/Music/dj-library/dubstep` (`scripts/make-dubstep-kit.py`)  
3. **Also on disk (not git)**: Drumprints, Stargate CC0, drum-machines under `~/Music/dj-library/`  
4. **MiniMax Music 3.0** — `control/src/minimax/*`, dashboard **Music Gen** panel, async jobs → `~/Music/dj-library/generated/`

## MiniMax

- Key: `MINIMAX_API_KEY` in `.env` **or** `~/MiniMax API.txt` (auto-load; do not commit)
- API: `https://api.minimax.io/v1/music_generation` model `music-3.0`
- Cmds: `music.status` | `music.previewPrompt` | `music.analyzeRef` | `music.lyrics` | `music.generate` | `music.job`
- Prompt style: English creative brief (mood + BPM + genre + scene + 2–3 instruments), not tag soup
- Expect **1–3 minutes** per generate; poll `music.job`

## Dashboard surfaces

| Panel | Role |
|-------|------|
| Files | Browse/load local audio; Shift+right-click → Music Gen reference |
| Roon · Simon | Zone transport / seek / volume |
| Decks A/B | Local mix only |
| Music Gen · MiniMax 3.0 | Create / cover, full controls, reference drop |
| Studio · Dubstep | Pads, wobble, seq, FX, transitions |

## Verify

```bash
cd engine && . .venv/bin/activate && pytest -q   # 46 passed as of handoff
cd control && npm run build
cd dashboard && npm run build
./scripts/e2e-smoke.sh                          # protocol path; no MiniMax
```

## Pitfalls

- Don’t `pkill -f` patterns that match the shell command line
- Shared mode needs Roon RAAT on `plug:pipewire` (`./scripts/roon-audio-mode.sh shared`)
- `dashboard/dist` is gitignored — `dev.sh` / `npm run build` before serving
- Cover mode needs a reference path; Create mode uses ref as vibe seed only
- Generated URLs from MiniMax expire in ~24h — we download immediately to disk

## Repo

- Remote: `https://github.com/Will-Amplify/madcool-dj`
- Branch: `master`
