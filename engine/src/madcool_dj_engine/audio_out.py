"""PipeWire/Pulse shared output via sounddevice (PortAudio).

Two modes (env ``DJ_AUDIO_MODE`` or ``device.setMode``):

- **shared** (default): open the PulseAudio/PipeWire "Default Sink" so other
  clients (and Roon via System Output) can mix concurrently. Do not yank the
  stream for Roon play.
- **exclusive**: hold whatever PortAudio default is; ``device.release`` frees
  the DAC so RoonBridge can grab exclusive ALSA on Tom - AES.
"""

from __future__ import annotations

import os
import subprocess
from typing import Any, Callable, Optional

import numpy as np

MODE_SHARED = "shared"
MODE_EXCLUSIVE = "exclusive"
_VALID_MODES = frozenset({MODE_SHARED, MODE_EXCLUSIVE})

_stream: Any = None
_callback: Optional[Callable[[int], np.ndarray]] = None
_sr: int = 44100
_blocksize: int = 1024
_mode: str = (os.environ.get("DJ_AUDIO_MODE") or MODE_SHARED).strip().lower()
if _mode not in _VALID_MODES:
    _mode = MODE_SHARED
_device_index: Optional[int] = None
_device_name: str = ""
_hostapi_name: str = ""


def get_mode() -> str:
    return _mode


def set_mode(mode: str) -> str:
    """Set audio arbitration mode. Does not reopen the stream by itself."""
    global _mode
    m = (mode or "").strip().lower()
    if m not in _VALID_MODES:
        raise ValueError(f"invalid_audio_mode: {mode!r} (expected shared|exclusive)")
    _mode = m
    return _mode


def audio_info() -> dict[str, Any]:
    return {
        "mode": _mode,
        "stream_active": stream_active(),
        "device_index": _device_index,
        "device_name": _device_name or None,
        "hostapi": _hostapi_name or None,
    }


def claim_default_sink() -> None:
    """Best-effort: knock rhythmbox off the default sink (exclusive hygiene)."""
    if _mode == MODE_SHARED:
        return
    try:
        subprocess.run(
            ["pkill", "-f", "rhythmbox"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, FileNotFoundError):
        pass


def pick_output_device(sd: Any) -> tuple[Optional[int], str, str]:
    """Choose an output device for the current mode.

    Returns (device_index_or_None_for_default, device_name, hostapi_name).
    """
    hostapis = list(sd.query_hostapis())
    devices = list(sd.query_devices())

    if _mode == MODE_SHARED:
        # Prefer PulseAudio "Default Sink" — PipeWire shared mixing.
        for i, d in enumerate(devices):
            if d.get("max_output_channels", 0) < 1:
                continue
            api = hostapis[d["hostapi"]]["name"]
            name = d["name"]
            if "Pulse" in api and "Default" in name:
                return i, name, api
        for i, d in enumerate(devices):
            if d.get("max_output_channels", 0) < 1:
                continue
            api = hostapis[d["hostapi"]]["name"]
            if "Pulse" in api:
                return i, d["name"], api

    # Exclusive / fallback: PortAudio default output.
    default = sd.default.device
    out_idx = default[1] if isinstance(default, (list, tuple)) else default
    if out_idx is None or out_idx < 0:
        return None, "default", "default"
    d = devices[out_idx]
    api = hostapis[d["hostapi"]]["name"]
    return out_idx, d["name"], api


def start_stream(
    callback: Callable[[int], np.ndarray], sr: int = 44100, blocksize: int = 1024
) -> Any:
    """Open and start a sounddevice OutputStream."""
    global _stream, _callback, _sr, _blocksize, _device_index, _device_name, _hostapi_name
    stop_stream()
    claim_default_sink()
    _callback = callback
    _sr = sr
    _blocksize = blocksize

    import sounddevice as sd

    device, name, hostapi = pick_output_device(sd)
    _device_index = device
    _device_name = name
    _hostapi_name = hostapi

    def _sd_callback(outdata, frames, time_info, status):  # noqa: ANN001
        if _callback is None:
            outdata.fill(0)
            return
        outdata[:] = _callback(frames)

    kwargs: dict[str, Any] = {
        "samplerate": sr,
        "channels": 2,
        "dtype": "float32",
        "blocksize": blocksize,
        "callback": _sd_callback,
    }
    if device is not None:
        kwargs["device"] = device

    stream = sd.OutputStream(**kwargs)
    stream.start()
    _stream = stream
    return stream


def stop_stream() -> bool:
    """Stop/close the output stream if open. Returns True if a stream was closed."""
    global _stream
    if _stream is None:
        return False
    try:
        _stream.stop()
        _stream.close()
    except Exception:
        pass
    _stream = None
    return True


def stream_active() -> bool:
    return _stream is not None and bool(getattr(_stream, "active", False))


def has_callback() -> bool:
    return _callback is not None


def restart_stream() -> Any:
    """Re-open the stream with the last callback (after a release / mode change)."""
    if _callback is None:
        raise RuntimeError("no_stream_callback_registered")
    return start_stream(_callback, sr=_sr, blocksize=_blocksize)


def levels_from_block(block: np.ndarray) -> dict:
    """Peak L/R levels (0..1) for a simple VU meter."""
    if block.size == 0:
        return {"peak_l": 0.0, "peak_r": 0.0}
    return {
        "peak_l": float(np.max(np.abs(block[:, 0]))),
        "peak_r": float(np.max(np.abs(block[:, 1]))),
    }


def energy_bins_from_audio(audio: np.ndarray, bins: int = 256) -> list[float]:
    """Downsample stereo/mono float audio to an RMS envelope for overview waveforms."""
    if audio.size == 0 or bins < 4:
        return []
    mono = audio.mean(axis=1) if audio.ndim == 2 else audio.reshape(-1)
    n = len(mono)
    if n == 0:
        return []
    edges = np.linspace(0, n, bins + 1, dtype=np.int64)
    out: list[float] = []
    peak = 1e-9
    raw: list[float] = []
    for i in range(bins):
        a, b = int(edges[i]), int(edges[i + 1])
        if b <= a:
            raw.append(0.0)
            continue
        chunk = mono[a:b]
        v = float(np.sqrt(np.mean(chunk * chunk)))
        raw.append(v)
        if v > peak:
            peak = v
    for v in raw:
        out.append(round(min(1.0, v / peak), 4))
    return out
