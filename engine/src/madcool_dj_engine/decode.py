"""Stereo decode for playback (as opposed to analyze.py's mono analysis decode).

Same ffmpeg-subprocess approach as analyze.py, but interleaved stereo s16le at
44100 Hz — the mixer's native format. Fixture clips are short (<=90s), so a
full-file load is fine for v1; long files aren't a target yet.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

SAMPLE_RATE = 44100


def load_stereo_44k(
    path: Path, start_sec: float = 0.0, max_seconds: float | None = None
) -> np.ndarray:
    """Decode any ffmpeg-readable audio file to float32 stereo @ 44100 Hz.

    Returns an (n, 2) array in [-1, 1]. `start_sec` seeks the input before
    decoding (cheap, since it's applied before `-i`), `max_seconds` caps how
    much gets decoded.
    """
    path = Path(path)
    cmd = ["ffmpeg", "-v", "error"]
    if start_sec > 0:
        cmd += ["-ss", str(start_sec)]
    cmd += ["-i", str(path)]
    if max_seconds is not None:
        cmd += ["-t", str(max_seconds)]
    cmd += [
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "2",
        "-ar",
        str(SAMPLE_RATE),
        "-",
    ]
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        timeout=90,
    )
    raw = np.frombuffer(proc.stdout, dtype=np.int16)
    if raw.size % 2:
        raw = raw[: raw.size - 1]
    stereo = raw.reshape(-1, 2).astype(np.float32) / 32768.0
    return stereo
