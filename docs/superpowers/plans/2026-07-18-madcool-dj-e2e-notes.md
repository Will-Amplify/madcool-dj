# MadCool DJ — e2e smoke notes

**Date:** 2026-07-18
**Host:** Tom (`i5-3210M`, no GPU, 4 cores) — sandboxed dev container on top of Tom, no PulseAudio/PipeWire session, no live Tailscale daemon.
**Worktree:** `/home/madcoolseed/Projects/madcool-dj/.worktrees/madcool-dj-impl` on `feature/madcool-dj-impl`

## Commands run

```bash
./scripts/e2e-smoke.sh
```

Pre-checked before running (all already in place, no setup needed):

- `fixtures/clips/clip_a.wav`, `fixtures/clips/clip_b.wav` present (~15MB each, ~90s).
- `engine/.venv` present with deps installed.
- `control/node_modules` present (`tsx` available).
- `dashboard/dist` already built (static assets served by `dj-control`).

## Result: PASS

Full protocol path exercised over the HTTP command bus against an isolated engine+control pair (own socket at `/tmp/madcool-e2e.sock`, own port `:8799`), exactly per `scripts/e2e-smoke.sh`:

`health` → `library.scan` (fixtures) → `analyze.file` (clip_a, clip_b) → `deck.load` a/b → `deck.play a` → `autopilot.enable` → `status`.

```
==> health
{"ok":true,"service":"madcool-dj-control"}

==> library.scan (root=.../fixtures/clips)
{"ok":true,"result":{"root":".../fixtures/clips","count":2}}

==> analyze.file (clip_a)
{"ok":true,"result":{"bpm":112.35,"duration_sec":90,"bands":{"sub":1,"bass":0.2461,"low_mid":0.0405,"high_mid":0.0117,"hats":0.0086}}}

==> analyze.file (clip_b)
{"ok":true,"result":{"bpm":136,"duration_sec":90,"bands":{"sub":1,"bass":0.2482,"low_mid":0.0723,"high_mid":0.0155,"hats":0.0106}}}

==> deck.load a / deck.load b
{"ok":true,"result":{"path":".../clip_a.wav","playing":false,"position_sec":0}}
{"ok":true,"result":{"path":".../clip_b.wav","playing":false,"position_sec":0}}

==> deck.play a
{"ok":true,"result":{"path":".../clip_a.wav","playing":true,"position_sec":0}}

==> autopilot.enable
{"ok":true,"result":{"autopilot":true}}

==> status
{"ok":true,"result":{"engine":"madcool-dj-engine","version":"0.1.0","crossfade":0,
  "decks":{"a":{"path":".../clip_a.wav","playing":true,"position_sec":0},
           "b":{"path":".../clip_b.wav","playing":false,"position_sec":0}},
  "autopilot":true}}

=== e2e-smoke summary ===
health.ok=true  status.ok=true  library.scan.count=2
deck.a.path=.../clip_a.wav  deck.a.playing=true  autopilot=true
PASS: protocol path (health + status) ok
EXIT_CODE=0
```

Every command in the plan's curl sequence (`library.scan` against `fixtures/clips`, load/play/autopilot/status) is covered 1:1 by this script — re-running it superseded doing the curls by hand.

## Sandbox quirk found during this run (worth flagging, not a code bug)

`e2e-smoke.sh`'s `cleanup()` trap sends `pkill -TERM`/`kill -TERM` then `-KILL` to the backgrounded engine (`python -m madcool_dj_engine`) and control (`tsx src/index.ts`, plus its respawned Node loader child) processes before exiting. In this sandboxed container, those signals did not land — both processes stayed alive (state `S`, not zombies) and the script's own `wait "$PID"` blocked in `cleanup()` for several minutes with the summary/`PASS` line already printed. Force-killing the tree from an unsandboxed (`required_permissions: ["all"]`) shell (`kill -9` on the engine, control, and their respawned child PIDs) immediately unblocked it; the backgrounded pipeline then reported `EXIT_CODE=0`, confirming this was a signal-delivery hang in cleanup, not a false pass.

Net effect: the protocol path genuinely passed (`EXIT_CODE=0`, all `ok:true`), but if you run this script directly inside a similarly sandboxed shell, don't be surprised if it "hangs after PASS" — that's cleanup being unable to signal its own children, not a hung server. On bare Tom (no sandbox wrapper) this has not been observed and isn't expected to recur.

## PortAudio / audio-out status: unavailable (expected)

`libportaudio2` / `portaudio19-dev` **are** installed at the OS level, and `sounddevice` imports at the Python-extension level — but `sounddevice`'s module-level `Pa_Initialize()` throws immediately:

```
sounddevice.PortAudioError: Error initializing PortAudio: Unanticipated host error [PaErrorCode -9999]:
'PulseAudio_Initialize: Can't connect to server' [<error getting host API: -10000> error -1]
```

There is no PulseAudio/PipeWire session running in this sandboxed container, so `import sounddevice` raises and exits non-zero — `e2e-smoke.sh`'s `python -c "import sounddevice"` guard correctly falls through to the no-`--play` branch. The engine ran protocol-only this run, exactly as designed for a headless/no-audio environment; no PipeWire → SXW DAC audio was attempted or expected here. This is an environment property of the sandbox, not something to "fix" in code.

## Roon status: pending (not reachable from this sandbox)

- No `~/.config/madcool-dj/roon_token` yet — extension has never completed a first pairing.
- `tailscale status` in this sandbox fails outright: `dial unix /var/run/tailscale/tailscaled.sock: connect: no such file or directory` — there is no live Tailscale daemon here, so Simon (`100.109.124.125:9330`) is not reachable at all from this container, independent of the Roon-side approval step.
- Did not attempt `npx tsx scripts/roon-smoke.ts` against the real Simon Core from here — it would just time out on network, not add signal beyond what's already known. `npx tsx scripts/roon-mock-smoke.ts` (no network, exercises pending/connected/error paths against a fake `RoonApi`) is the right sandbox-safe substitute if that path needs re-verification; not re-run this session since it's unrelated to the e2e protocol check.
- Bottom line unchanged from README: `roon.zones` / `roon.control` will fail fast with `roon_pending_authorization` until Simon-side approval happens — this is expected, not a bug, and this sandbox can't get any further on it regardless (no Tailscale path to Simon at all).

## Remaining manual steps for Will

1. **Approve the Roon extension on Simon** — open Roon → Settings → Extensions on Simon, find "MadCool DJ", click **Enable**. Do this from a machine that actually has Tailscale up (not this sandbox). Once approved, the token persists to `~/.config/madcool-dj/roon_token` (`0600`) and future runs reconnect silently.
2. **Install/verify PortAudio + a running audio session on bare Tom** (outside any sandbox) if `--play` audio-out hasn't been confirmed there yet — `libportaudio2`/`portaudio19-dev` are already present per this check, so it's really about having PulseAudio/PipeWire actually running (desktop session or a user-level pipewire service), not missing packages. Confirm with the "Listen smoke" snippet in `README.md` once a Roon zone / DAC route exists.
3. **Open the dashboard** (`http://<tom-host>:8787/`, built already at `dashboard/dist`) and eyeball dual-deck state, meters, and the agent/activity log against a live `dj-control` (via `./scripts/dev.sh`, not the isolated `e2e-smoke.sh` pair) to sanity-check the UI against real state once audio + Roon are both live.
4. If re-running `e2e-smoke.sh` inside a sandboxed shell again and it appears to hang after printing `PASS`, it's the cleanup-signal quirk above — safe to force-kill the leftover `madcool_dj_engine` / `tsx src/index.ts` processes rather than assuming a real hang.
