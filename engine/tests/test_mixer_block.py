from pathlib import Path

import numpy as np
import pytest

from madcool_dj_engine.mixer import DeckState, DualDeckMixer, equal_power_gains


def _fixture(name: str) -> Path:
    return Path(__file__).resolve().parents[2] / "fixtures" / "clips" / name


def _sine_stereo(freq: float, seconds: float, sr: int = 44100, amp: float = 0.5) -> np.ndarray:
    t = np.arange(int(sr * seconds)) / sr
    mono = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    return np.stack([mono, mono], axis=1)


def _mixer_with_sines() -> DualDeckMixer:
    mixer = DualDeckMixer()
    mixer.decks["a"] = DeckState(path=Path("a.wav"), audio=_sine_stereo(220.0, 2.0), playing=True)
    mixer.decks["b"] = DeckState(path=Path("b.wav"), audio=_sine_stereo(440.0, 2.0), playing=True)
    return mixer


def test_mix_block_shape_and_dtype():
    mixer = _mixer_with_sines()
    block = mixer.mix_block(512)
    assert block.shape == (512, 2)
    assert block.dtype == np.float32


def test_mix_block_silence_when_no_decks_loaded():
    mixer = DualDeckMixer()
    block = mixer.mix_block(256)
    assert block.shape == (256, 2)
    assert np.all(block == 0.0)


def test_mix_block_silence_when_paused():
    mixer = _mixer_with_sines()
    mixer.decks["a"].playing = False
    mixer.decks["b"].playing = False
    block = mixer.mix_block(256)
    assert np.all(block == 0.0)


def test_mix_block_advances_position_and_stops_playing_at_end():
    mixer = _mixer_with_sines()
    mixer.decks["a"].audio = mixer.decks["a"].audio[:100]
    mixer.mix_block(64)
    assert mixer.decks["a"].position == 64
    assert mixer.decks["a"].playing is True

    mixer.mix_block(64)
    assert mixer.decks["a"].position == 100
    assert mixer.decks["a"].playing is False


def test_mix_block_clips_soft_to_unit_range():
    mixer = DualDeckMixer()
    loud = np.ones((256, 2), dtype=np.float32) * 5.0
    mixer.decks["a"] = DeckState(path=Path("a.wav"), audio=loud, playing=True)
    block = mixer.mix_block(256)
    assert np.max(np.abs(block)) <= 1.0


def test_crossfade_zero_favors_deck_a():
    mixer = _mixer_with_sines()
    mixer.set_crossfade(0.0)
    block = mixer.mix_block(4096)

    a_ref = _sine_stereo(220.0, 2.0)[:4096, 0]
    b_ref = _sine_stereo(440.0, 2.0)[:4096, 0]

    corr_a = float(np.corrcoef(block[:, 0], a_ref)[0, 1])
    corr_b = float(np.corrcoef(block[:, 0], b_ref)[0, 1])
    assert corr_a > 0.99
    assert abs(corr_b) < 0.2


def test_crossfade_one_favors_deck_b():
    mixer = _mixer_with_sines()
    mixer.set_crossfade(1.0)
    block = mixer.mix_block(4096)

    a_ref = _sine_stereo(220.0, 2.0)[:4096, 0]
    b_ref = _sine_stereo(440.0, 2.0)[:4096, 0]

    corr_a = float(np.corrcoef(block[:, 0], a_ref)[0, 1])
    corr_b = float(np.corrcoef(block[:, 0], b_ref)[0, 1])
    assert corr_b > 0.99
    assert abs(corr_a) < 0.2


def test_set_crossfade_clamps_to_unit_range():
    mixer = DualDeckMixer()
    mixer.set_crossfade(-1.0)
    assert mixer.crossfade == 0.0
    mixer.set_crossfade(2.0)
    assert mixer.crossfade == 1.0


def test_load_play_pause_from_fixture_if_present():
    p = _fixture("clip_a.wav")
    if not p.exists():
        pytest.skip("fixtures missing")
    mixer = DualDeckMixer()
    mixer.load("a", p)
    assert mixer.decks["a"] is not None
    assert mixer.decks["a"].playing is False

    mixer.play("a")
    block = mixer.mix_block(1024)
    assert block.shape == (1024, 2)
    assert mixer.decks["a"].position == 1024

    mixer.pause("a")
    pos_before = mixer.decks["a"].position
    mixer.mix_block(1024)
    assert mixer.decks["a"].position == pos_before


def test_equal_power_gains_endpoints_still_pass():
    a, b = equal_power_gains(0.0)
    assert a == pytest.approx(1.0)
    assert b == pytest.approx(0.0)
    a, b = equal_power_gains(1.0)
    assert a == pytest.approx(0.0)
    assert b == pytest.approx(1.0)
