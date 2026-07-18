"""PipeWire/ALSA output via sounddevice.

`sounddevice` (PortAudio) is imported lazily inside the functions below —
this module needs to stay importable (and its callers testable) on machines
or sandboxes without the native PortAudio library installed. Real hardware
output only gets exercised on tom-1.
"""

from __future__ import annotations

import subprocess
from typing import Any, Callable

import numpy as np


def claim_default_sink() -> None:
    """Best-effort: knock rhythmbox (or anything else auto-grabbing the
    default sink) off the output so the engine can claim it cleanly.
    """
    try:
        subprocess.run(
            ["pkill", "-f", "rhythmbox"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, FileNotFoundError):
        pass


def start_stream(
    callback: Callable[[int], np.ndarray], sr: int = 44100, blocksize: int = 1024
) -> Any:
    """Open and start a sounddevice OutputStream on the default output.

    `callback(n_frames) -> (n_frames, 2) float32` supplies audio — this is
    exactly `DualDeckMixer.mix_block`'s signature, so the common call is
    `start_stream(mixer.mix_block)`.
    """
    import sounddevice as sd

    def _sd_callback(outdata, frames, time_info, status):  # noqa: ANN001
        outdata[:] = callback(frames)

    stream = sd.OutputStream(
        samplerate=sr,
        channels=2,
        dtype="float32",
        blocksize=blocksize,
        callback=_sd_callback,
    )
    stream.start()
    return stream


def levels_from_block(block: np.ndarray) -> dict:
    """Peak L/R levels (0..1) for a simple VU meter."""
    if block.size == 0:
        return {"peak_l": 0.0, "peak_r": 0.0}
    return {
        "peak_l": float(np.max(np.abs(block[:, 0]))),
        "peak_r": float(np.max(np.abs(block[:, 1]))),
    }
