"""library.browse one-level listing."""

from __future__ import annotations

import os
from pathlib import Path

from madcool_dj_engine.library import browse_dir


def test_browse_lists_dirs_and_audio(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MADCOOL_DJ_EXTRA_ROOTS", str(tmp_path))
    (tmp_path / "sub").mkdir()
    (tmp_path / "skip.txt").write_text("x")
    (tmp_path / "track.wav").write_bytes(b"RIFF")
    (tmp_path / ".hidden").mkdir()
    out = browse_dir(tmp_path)
    assert out["path"] == str(tmp_path.resolve())
    assert {d["name"] for d in out["dirs"]} == {"sub"}
    assert {f["name"] for f in out["files"]} == {"track.wav"}
    assert out["files"][0]["title"] == "track"
    # Parent of tmp_path is outside the allowlist → None (can't climb out)
    assert out["parent"] is None


def test_browse_parent_within_allowlist(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MADCOOL_DJ_EXTRA_ROOTS", str(tmp_path))
    child = tmp_path / "nested"
    child.mkdir()
    out = browse_dir(child)
    assert out["parent"] == str(tmp_path.resolve())
