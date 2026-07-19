"""Library scanning helpers shared by command handlers and the autopilot.

Kept separate from `commands.py` so the autopilot planner (and anything
else that needs a track listing) doesn't have to import the full
command-dispatch surface just to walk a directory of audio files.
"""

from __future__ import annotations

from pathlib import Path

AUDIO_EXTS = {".wav", ".flac", ".mp3", ".aiff", ".aif", ".ogg", ".m4a", ".aac"}


def scan_dir(root: str | Path) -> list[str]:
    """Return sorted, resolved path strings for audio files under `root`.

    A missing root scans to an empty list rather than raising — callers
    (CLI, protocol commands) decide how to report "nothing found" vs. a
    bad root path.
    """
    root_path = Path(root)
    if not root_path.exists():
        return []
    return [
        str(candidate.resolve())
        for candidate in sorted(root_path.rglob("*"))
        if candidate.is_file() and candidate.suffix.lower() in AUDIO_EXTS
    ]


def browse_dir(path: str | Path) -> dict:
    """One-level directory listing for the files panel (dirs + audio files)."""
    root = Path(path).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"not_a_directory: {root}")
    dirs: list[dict] = []
    files: list[dict] = []
    try:
        children = sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError as exc:
        raise PermissionError(f"permission_denied: {root}") from exc
    for child in children:
        if child.name.startswith("."):
            continue
        if child.is_dir():
            dirs.append({"name": child.name, "path": str(child)})
        elif child.is_file() and child.suffix.lower() in AUDIO_EXTS:
            files.append({"name": child.name, "path": str(child), "title": child.stem})
    parent = str(root.parent) if root.parent != root else None
    return {
        "path": str(root),
        "parent": parent,
        "dirs": dirs,
        "files": files,
    }
