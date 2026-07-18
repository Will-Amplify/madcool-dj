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

Roon Core runs on Simon (`ROON_HOST=100.109.124.125`). First connection from this host requires **approve-once** in the Roon app on Simon.

## Fixtures

Run `./scripts/make-fixtures.sh` to slice ~90s WAV clips from source mixes under `MUSIC_ROOT`. Generated `.wav` files stay local (gitignored); only `fixtures/clips/.gitkeep` is tracked.
