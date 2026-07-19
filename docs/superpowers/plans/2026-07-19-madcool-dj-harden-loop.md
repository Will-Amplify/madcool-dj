# MadCool DJ Harden Loop Implementation Plan

> **For agentic workers:** Execute task-by-task. Keep Tom CPU gentle. Do not re-scaffold. Do not expand Spotify/Tidal cradles.

**Goal:** Add lint to the verify gate, split the dashboard monolith, and surface silent engine exceptions — without breaking the green protocol path.

**Architecture:** Three independent slices that each keep `./scripts/verify.sh` green. Lint is additive to verify. Dashboard split is mechanical module extraction with shared deps passed in. Engine logging uses existing `logging` loggers; audio-callback errors are rate-limited.

**Tech Stack:** ruff (engine), TypeScript/Vite (dashboard), Python logging (engine)

## Global Constraints

- Tom: i5-3210M, no GPU — no heavy lint/formatter loops in runtime paths
- Verify gate remains the professional bar: pytest → builds → control smokes → e2e
- Out of scope: Spotify/Tidal PCM, stems, Roon-as-mix-output
- `.env` secrets never committed

---

### Task 1: Lint cradle (ruff + typecheck in verify)

**Files:**
- Modify: `engine/pyproject.toml` (dev dep + ruff config)
- Modify: `dashboard/package.json` (add `typecheck`)
- Modify: `control/package.json` (add `typecheck` if missing)
- Modify: `scripts/verify.sh`

- [ ] Install ruff into engine venv; add `[tool.ruff]` targeting `src` + `tests`
- [ ] Fix or narrowly ignore any ruff findings that are noise
- [ ] Add `npm run typecheck` → `tsc --noEmit` for control + dashboard
- [ ] Wire `ruff check` + both typechecks into `verify.sh` before/alongside builds
- [ ] Run verify slice for lint/typecheck

### Task 2: Engine exception logging

**Files:**
- Modify: `engine/src/madcool_dj_engine/commands.py`
- Modify: `engine/src/madcool_dj_engine/audio_out.py`
- Modify: `engine/src/madcool_dj_engine/analyze.py`
- Modify: `engine/src/madcool_dj_engine/autopilot.py`
- Leave expected `OSError` on disconnect/`pkill` miss as silent or debug-only

- [ ] Add module loggers where missing
- [ ] Log kit-load / waveform / device-claim / fingerprint / notify_override failures at warning/debug
- [ ] Rate-limit mix-callback exception logging (≤3 then every 1000)
- [ ] Run `pytest -q`

### Task 3: Split `dashboard/src/main.ts`

**Files:**
- Create: `dashboard/src/types.ts`, `dom.ts`, `api.ts`, `wave.ts`, `studio.ts`, `musicGen.ts`, `roonUi.ts`
- Modify: `dashboard/src/main.ts` (orchestration only)

- [ ] Extract types
- [ ] Extract `byId` + API helpers (`cmd`/`getStatus`/`authHeaders`)
- [ ] Extract waveform/bands drawing
- [ ] Extract studio mount + music gen mount + roon render as init functions taking deps
- [ ] Keep decks/library/WS/keyboard in `main.ts` for this pass (further split later if needed)
- [ ] `npm run build` + `npm run typecheck` in dashboard

### Task 4: Full gate + docs touch

- [ ] `./scripts/verify.sh` ALL GREEN
- [ ] Update handoff receipt line for this loop
- [ ] Commit when user confirms merge (or as part of explicit merge step)
