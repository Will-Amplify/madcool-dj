"""Path allowlist + FX bypass + autopilot lifecycle regression tests."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import numpy as np
import pytest

from madcool_dj_engine.autopilot import Autopilot
from madcool_dj_engine.commands import CommandError, EngineCommandHandler
from madcool_dj_engine.fx import FILTER_BYPASS_HZ, MasterFX
from madcool_dj_engine.mixer import DualDeckMixer
from madcool_dj_engine.paths import resolve_under_allowlist


FIXTURE_CLIPS = Path(__file__).resolve().parents[2] / "fixtures" / "clips"


def test_allowlist_accepts_fixtures():
    clip = FIXTURE_CLIPS / "clip_a.wav"
    if not clip.exists():
        pytest.skip("fixtures missing")
    resolved = resolve_under_allowlist(clip)
    assert resolved == clip.resolve()


def test_allowlist_rejects_etc_passwd():
    with pytest.raises(PermissionError, match="path_outside_allowlist"):
        resolve_under_allowlist("/etc/passwd")


def test_deck_load_rejects_outside_allowlist():
    h = EngineCommandHandler(DualDeckMixer())
    with pytest.raises(CommandError, match="path_outside_allowlist"):
        h.dispatch("deck.load", {"deck": "a", "path": "/etc/passwd"})


def test_fx_default_bypasses_filter():
    fx = MasterFX(44100)
    x = (np.random.randn(1024, 2) * 0.2).astype(np.float32)
    y = fx.process(x.copy())
    # Default filter_hz == FILTER_BYPASS_HZ → near identity (no LFO/delay/crush)
    assert fx.params.filter_hz >= FILTER_BYPASS_HZ
    assert np.allclose(x, y, atol=1e-6)


def test_fx_engaged_filter_changes_signal():
    fx = MasterFX(44100)
    x = (np.random.randn(1024, 2) * 0.3).astype(np.float32)
    fx.set(filter_hz=200.0, lfo_hz=0.0, lfo_depth=0.0)
    y = fx.process(x.copy())
    assert float(np.mean(np.abs(y))) < float(np.mean(np.abs(x)))


def test_autopilot_enable_disable_single_thread():
    handler = EngineCommandHandler(DualDeckMixer())
    ap = Autopilot(handler, lambda *_: None)
    ap.enable()
    t1 = ap._thread
    assert t1 is not None and t1.is_alive()
    ap.enable()  # idempotent — should not spawn a second live planner
    alive = sum(1 for t in threading.enumerate() if t.name == "autopilot" and t.is_alive())
    assert alive == 1
    ap.disable()
    time.sleep(0.05)
    alive_after = sum(1 for t in threading.enumerate() if t.name == "autopilot" and t.is_alive())
    assert alive_after == 0
    # Re-enable after disable still works
    ap.enable()
    assert ap._thread is not None and ap._thread.is_alive()
    ap.disable()
