"""Cue pick + tempo match helpers."""

import pytest

from madcool_dj_engine.cue import pick_intro_cue_sec, tempo_match_rate


def test_tempo_match_rate_clamps():
    assert tempo_match_rate(128, 128) == 1.0
    assert tempo_match_rate(128, 129) == pytest.approx(128 / 129, rel=1e-6)
    assert tempo_match_rate(128, 100) == pytest.approx(1.03)
    assert tempo_match_rate(100, 128) == pytest.approx(0.97)
    assert tempo_match_rate(0, 128) == 1.0


def test_pick_intro_cue_prefers_first_beat():
    analysis = {"duration_sec": 90, "beats": [0.1, 0.55, 1.0], "energy": [0.1] * 64}
    assert pick_intro_cue_sec(analysis) == 0.55


def test_pick_intro_cue_falls_back_to_energy_valley():
    energy = [0.9] * 32 + [0.05] + [0.8] * 31
    analysis = {"duration_sec": 64.0, "beats": [], "energy": energy}
    cue = pick_intro_cue_sec(analysis, prefer_after_sec=0.4)
    assert cue >= 0.4
    assert cue < 40.0
