"""Directory browse helpers."""

from __future__ import annotations

from pathlib import Path

from madcool_dj_engine.library import browse_dir


def test_browse_lists_dirs_and_audio(tmp_path: Path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "skip.txt").write_text("x")
    (tmp_path / "track.wav").write_bytes(b"RIFF")
    (tmp_path / ".hidden").mkdir()
    out = browse_dir(tmp_path)
    assert out["path"] == str(tmp_path.resolve())
    assert any(d["name"] == "sub" for d in out["dirs"])
    assert any(f["name"] == "track.wav" for f in out["files"])
    assert not any(d["name"] == ".hidden" for d in out["dirs"])
    assert not any(f["name"] == "skip.txt" for f in out["files"])
