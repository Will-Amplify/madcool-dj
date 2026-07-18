"""Library scanning helpers shared by command handlers and the autopilot.

Kept separate from `commands.py` so the autopilot planner (and anything
else that needs a track listing) doesn't have to import the full
command-dispatch surface just to walk a directory of audio files.
"""

from __future__ import annotations

from pathlib import Path

AUDIO_EXTS = {".wav", ".flac", ".mp3"}


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
