"""Waveform / shared-audio helpers."""

from __future__ import annotations

import numpy as np
import pytest

from madcool_dj_engine.audio_out import energy_bins_from_audio, get_mode, set_mode
from madcool_dj_engine.mixer import DeckState, DualDeckMixer


def test_energy_bins_normalizes_and_lengths():
    t = np.linspace(0, 1, 8000, dtype=np.float32)
    mono = (0.5 * np.sin(2 * np.pi * 40 * t)).astype(np.float32)
    stereo = np.stack([mono, mono], axis=1)
    bins = energy_bins_from_audio(stereo, bins=64)
    assert len(bins) == 64
    assert max(bins) == pytest.approx(1.0, abs=1e-3)
    assert min(bins) >= 0.0


def test_mixer_waveform_from_loaded_buffer():
    m = DualDeckMixer(sr=44100)
    audio = np.zeros((44100, 2), dtype=np.float32)
    audio[10000:12000] = 0.8
    m.decks["a"] = DeckState(path=__import__("pathlib").Path("x.wav"), audio=audio)
    w = m.waveform("a", bins=32)
    assert len(w) == 32
    assert max(w) > 0.5


def test_set_mode_rejects_junk():
    prev = get_mode()
    try:
        with pytest.raises(ValueError):
            set_mode("wireless")
        assert set_mode("exclusive") == "exclusive"
        assert set_mode("shared") == "shared"
    finally:
        set_mode(prev)
