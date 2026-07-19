import time
from pathlib import Path

from madcool_dj_engine import ANALYZER_VERSION
from madcool_dj_engine.cache import cache_key, load_analysis, save_analysis


def test_cache_key_stable(tmp_path: Path):
    f = tmp_path / "a.wav"
    f.write_bytes(b"RIFF")
    k1 = cache_key(f)
    k2 = cache_key(f)
    assert k1 == k2
    assert len(k1) == 40  # sha1 hex


def test_cache_key_changes_on_content(tmp_path: Path):
    f = tmp_path / "a.wav"
    f.write_bytes(b"RIFF")
    k1 = cache_key(f)
    time.sleep(0.01)
    f.write_bytes(b"RIFF2")
    k2 = cache_key(f)
    assert k1 != k2


def test_save_and_load_roundtrip(tmp_path: Path, monkeypatch):
    # redirect cache_dir to tmp
    import madcool_dj_engine.cache as cache_mod
    monkeypatch.setattr(cache_mod, "cache_dir", lambda: tmp_path / "analysis")
    f = tmp_path / "track.wav"
    f.write_bytes(b"RIFFDATA")
    assert load_analysis(f) is None
    save_analysis(f, {"bpm": 128})
    data = load_analysis(f)
    assert data is not None
    assert data["bpm"] == 128
    assert data["analyzer_version"] == ANALYZER_VERSION
