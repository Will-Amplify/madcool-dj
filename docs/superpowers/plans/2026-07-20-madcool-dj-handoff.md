# MadCool DJ — closeout & handoff (2026-07-20)

**Status:** Closed on `master` · remote synced · verify green (tip: `git log -1`)  
**Host:** Tom · PipeWire shared with Roon on Simon  
**Repo:** https://github.com/Will-Amplify/madcool-dj

---

## One-liner

Dual-process local DJ: Python engine (mix/analyze/autopilot/studio) + TypeScript control (HTTP/WS/MCP/Roon/MiniMax) + Vite dashboard. Verify gate includes ruff, typecheck, pytest, builds, control smokes, and isolated e2e (no Roon thrash).

---

## Boot

```bash
cd ~/Projects/madcool-dj
cp -n .env.example .env   # set DJ_TOKEN if DJ_HOST is non-loopback
./scripts/verify.sh       # gate before trusting a session
./scripts/dev.sh          # dashboard at http://<DJ_HOST>:8787/
```

Paste `DJ_TOKEN` into the dashboard token field when not on loopback.

Optional always-on:

```bash
cp scripts/systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now madcool-dj-engine.service madcool-dj-control.service
```

Shared audio with Roon:

```bash
./scripts/roon-audio-mode.sh shared   # RAAT → plug:pipewire
```

Skip Roon registration (dev/e2e): `ROON_DISABLED=1` or `DJ_E2E=1`.

---

## Surface map

| Layer | Owns |
|-------|------|
| `engine/` | Decks, EQ, FX, studio, analyze cache, autopilot, path jail, `levels` telemetry |
| `control/` | `:8787` HTTP + `/v1/live` WS + MCP + Roon + MiniMax bus |
| `dashboard/` | Dual decks, Files, Roon, Studio, Music Gen, VU, plan card (`src/{main,studio,musicGen,roonUi,…}.ts`) |
| `scripts/verify.sh` | ruff → typecheck → pytest → builds → control smokes → e2e |

**Keyboard:** A/B focus · Space play/pause · ←/→ crossfade · Q cue

---

## Commands worth remembering

```text
status · library.scan|list|browse · analyze.file
deck.load|play|pause|seek|jog|cue|setCue|setRate|setGain|setEq
mixer.crossfade {position} | {to, bars|seconds}
autopilot.enable|disable
device.claim|release|setMode
fx.set · studio.* · sampler.* · synth.* · seq.* · transition.run
roon.zones|control|seek|volume|mute|settings
music.status|previewPrompt|analyzeRef|lyrics|generate|job|jobs
```

Autopilot: BPM ±6% pick → intro cue → rate ±3% → mid snap → ramp. Manual deck/mixer cancels ramp.

---

## Auth & jail

- Non-loopback bind **requires** `DJ_TOKEN` (boot refuse).
- Paths only under: `MUSIC_ROOT`, repo `fixtures/`, `~/.cache/madcool-dj`, `~/Music/dj-library` (+ `MADCOOL_DJ_EXTRA_ROOTS`).
- Unix socket mode `0600`. `.env` never committed.
- e2e uses per-run socket + ephemeral port; sets `ROON_DISABLED=1` so protocol tests never register the live extension on Simon.

---

## Verify receipt (closeout)

```bash
./scripts/verify.sh
# 2026-07-20 closeout: ALL GREEN
# ruff · control/dashboard typecheck · 56 pytest · builds · auth/sources/roon/mcp · e2e PASS
# e2e: isolated sock/port · Roon skipped · health · scan=2 · deck A playing · autopilot · browse · studio · xfade
```

Recent landings on this closeout:

- `ad751fc` — lint cradle, dashboard modules, engine exception logging
- `ac077a0` — e2e isolation, Roon skip/rate-limit, unused-locals typecheck

---

## Manual remaining (Will / Tom)

1. Roon → Settings → Extensions → Enable **MadCool DJ** on Simon (if not already).
2. Confirm SXW DAC hear path with README “Listen smoke” or live fixtures.
3. Put dashboard token = `.env` `DJ_TOKEN` when serving on Tailscale/`0.0.0.0`.

---

## Out of scope (still cradles)

Spotify/Tidal PCM · stems · Roon as mix output · cloud ML beyond MiniMax gen

---

## Docs

| Doc | Role |
|-----|------|
| This file | Closeout / next-agent fast path |
| `docs/superpowers/specs/2026-07-18-madcool-dj-design.md` | Locked design |
| `docs/superpowers/plans/2026-07-19-madcool-dj-harden-loop.md` | Lint / split / logging plan |
| `docs/superpowers/plans/2026-07-18-madcool-dj.md` | Original impl plan (historical) |
| `docs/superpowers/plans/2026-07-18-madcool-dj-e2e-notes.md` | Early e2e sandbox notes |
| `README.md` | Runbook |

**Next agent:** start at `./scripts/verify.sh`, then `./scripts/dev.sh`. Do not re-scaffold.
