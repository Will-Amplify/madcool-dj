from pathlib import Path

import pytest

from madcool_dj_engine.analyze import analyze_file


def _fixture(name: str) -> Path:
    return Path(__file__).resolve().parents[2] / "fixtures" / "clips" / name


def test_analyze_fixture():
    p = _fixture("clip_a.wav")
    if not p.exists():
        pytest.skip("fixtures missing")
    r = analyze_file(p)
    assert r["duration_sec"] > 60
    assert 60 < r["bpm"] < 200
    assert set(r["bands"].keys()) >= {"sub", "bass", "low_mid", "high_mid", "hats"}


def test_analyze_uses_cache(monkeypatch):
    p = _fixture("clip_a.wav")
    if not p.exists():
        pytest.skip("fixtures missing")

    import madcool_dj_engine.analyze as analyze_mod

    first = analyze_file(p)

    def _boom(*args, **kwargs):
        raise AssertionError("decode_mono_22k should not be called on a cache hit")

    monkeypatch.setattr(analyze_mod, "decode_mono_22k", _boom)
    second = analyze_file(p)
    assert second["bpm"] == first["bpm"]
