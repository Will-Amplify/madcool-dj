"""Transport / jog / cue tests for DualDeckMixer."""

from __future__ import annotations

import numpy as np
import pytest

from madcool_dj_engine.mixer import DualDeckMixer, equal_power_gains


def _tone(sr: int = 44100, sec: float = 2.0, freq: float = 440.0) -> np.ndarray:
    t = np.arange(int(sr * sec), dtype=np.float32) / sr
    mono = 0.2 * np.sin(2 * np.pi * freq * t)
    return np.stack([mono, mono], axis=1)


def test_equal_power_endpoints_still_ok():
    a, b = equal_power_gains(0.0)
    assert a == pytest.approx(1.0)
    assert b == pytest.approx(0.0)


def test_seek_and_jog(tmp_path):
    m = DualDeckMixer(sr=44100)
    # inject without ffmpeg
    from madcool_dj_engine.mixer import DeckState
    from pathlib import Path

    audio = _tone()
    m.decks["a"] = DeckState(path=Path("tone.wav"), audio=audio)
    m.seek("a", 1.0)
    assert m.decks["a"].position == pytest.approx(44100, abs=1)
    m.jog("a", -0.25)
    assert m.decks["a"].position == pytest.approx(int(0.75 * 44100), abs=2)


def test_cue_jumps_and_pauses():
    from madcool_dj_engine.mixer import DeckState
    from pathlib import Path

    m = DualDeckMixer()
    audio = _tone()
    m.decks["a"] = DeckState(path=Path("tone.wav"), audio=audio, position=1000, playing=True)
    m.set_cue("a", 0.5)
    m.cue("a")
    assert m.decks["a"].playing is False
    assert m.decks["a"].position == pytest.approx(int(0.5 * 44100), abs=1)


def test_rate_advances_faster():
    from madcool_dj_engine.mixer import DeckState
    from pathlib import Path

    m = DualDeckMixer()
    audio = _tone(sec=1.0)
    m.decks["a"] = DeckState(path=Path("tone.wav"), audio=audio, playing=True, rate=2.0)
    m.mix_block(1000)
    # at 2x, ~2000 source frames consumed
    assert m.decks["a"].position == pytest.approx(2000, abs=5)
