"""Lightweight, pure-numpy audio analyzer.

No librosa, no Demucs — just ffmpeg for decode and numpy/scipy for the math.
Built to be gentle on old hardware (i5-3210M class machines): we `os.nice(10)`
before the heavy FFT work and keep everything O(n) over a modest hop size.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

import numpy as np

from madcool_dj_engine.cache import load_analysis, save_analysis

SAMPLE_RATE = 22050
HOP = 512
FRAME = 2048

# Band edges in Hz.
BAND_EDGES = {
    "sub": (0.0, 60.0),
    "bass": (60.0, 250.0),
    "low_mid": (250.0, 2000.0),
    "high_mid": (2000.0, 6000.0),
    "hats": (6000.0, float(SAMPLE_RATE) / 2.0),
}

BPM_MIN = 70.0
BPM_MAX = 180.0

ACOUSTID_FINGERPRINT_SECONDS = 120.0


def decode_mono_22k(path: Path, max_seconds: Optional[float] = None) -> tuple[np.ndarray, int]:
    """Decode any ffmpeg-readable audio file to float32 mono @ 22050 Hz."""
    path = Path(path)
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(path),
    ]
    if max_seconds is not None:
        cmd += ["-t", str(max_seconds)]
    cmd += [
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    audio = np.frombuffer(proc.stdout, dtype=np.float32)
    return audio, SAMPLE_RATE


def _onset_envelope(audio: np.ndarray, hop: int = HOP, frame: int = FRAME) -> np.ndarray:
    """Spectral-flux onset strength envelope, one value per hop."""
    n_frames = max(0, (len(audio) - frame) // hop + 1)
    if n_frames < 2:
        return np.zeros(max(n_frames, 0), dtype=np.float64)

    window = np.hanning(frame).astype(np.float64)
    prev_mag = None
    flux = np.zeros(n_frames, dtype=np.float64)
    for i in range(n_frames):
        start = i * hop
        seg = audio[start : start + frame].astype(np.float64) * window
        mag = np.abs(np.fft.rfft(seg))
        if prev_mag is not None:
            diff = mag - prev_mag
            diff[diff < 0] = 0.0
            flux[i] = diff.sum()
        prev_mag = mag
    return flux


def _smooth(x: np.ndarray, width: int = 3) -> np.ndarray:
    if width <= 1 or len(x) < width:
        return x
    kernel = np.ones(width) / width
    return np.convolve(x, kernel, mode="same")


def _estimate_bpm(onset_env: np.ndarray, sr: int, hop: int = HOP) -> tuple[float, list[float]]:
    """Normalized-autocorrelation tempo pick, then peak-pick beats at that period.

    Raw (unnormalized) autocorrelation is biased toward small lags simply because
    more samples overlap there, so we use a proper normalized cross-correlation
    per lag. We also apply a gentle log-tempo prior centered on 120 BPM (a common
    trick in tempo estimation, e.g. Ellis 2007) to break ties between octave-related
    candidates in favor of the more danceable one — DJ fixtures skew 110-150 BPM.
    """
    if len(onset_env) < 4:
        return 120.0, []

    env = _smooth(onset_env, 3)
    env = env - env.mean()
    env = np.clip(env, 0.0, None)

    frame_rate = sr / hop  # onset-envelope frames per second
    n = len(env)

    lag_min = max(1, int(frame_rate * 60.0 / BPM_MAX))
    lag_max = min(n - 1, int(frame_rate * 60.0 / BPM_MIN))
    if lag_max <= lag_min:
        return 120.0, []

    best_score = -1.0
    best_lag = lag_min
    for lag in range(lag_min, lag_max + 1):
        a = env[: n - lag]
        b = env[lag:]
        denom = np.sqrt(np.sum(a * a) * np.sum(b * b))
        if denom <= 0:
            continue
        score = float(np.sum(a * b) / denom)
        bpm_candidate = 60.0 * frame_rate / lag
        prior = np.exp(-0.5 * ((np.log2(bpm_candidate / 120.0)) / 0.6) ** 2)
        weighted = score * prior
        if weighted > best_score:
            best_score = weighted
            best_lag = lag

    bpm = float(np.clip(60.0 * frame_rate / best_lag, BPM_MIN, BPM_MAX))

    beat_period_frames = frame_rate * 60.0 / bpm
    beats = _pick_beats(env, beat_period_frames, hop, sr)
    return bpm, beats


def _pick_beats(env: np.ndarray, period_frames: float, hop: int, sr: int) -> list[float]:
    """Greedy peak-picking near multiples of the estimated beat period."""
    if period_frames <= 0 or len(env) == 0:
        return []

    beats: list[float] = []
    pos = 0.0
    half_window = max(1, int(period_frames * 0.25))
    n = len(env)
    while pos < n:
        lo = max(0, int(pos - half_window))
        hi = min(n, int(pos + half_window) + 1)
        if hi > lo:
            local = env[lo:hi]
            peak_idx = lo + int(np.argmax(local))
        else:
            peak_idx = int(pos)
        beats.append(round(peak_idx * hop / sr, 3))
        pos += period_frames
    return beats


def _band_energies(audio: np.ndarray, sr: int, hop: int = HOP, frame: int = FRAME) -> dict[str, float]:
    """Mean FFT-magnitude energy per band, normalized so the max band is 1.0."""
    n_frames = max(0, (len(audio) - frame) // hop + 1)
    bands = list(BAND_EDGES.keys())
    totals = {b: 0.0 for b in bands}

    if n_frames < 1:
        return {b: 0.0 for b in bands}

    freqs = np.fft.rfftfreq(frame, d=1.0 / sr)
    band_masks = {b: (freqs >= lo) & (freqs < hi) for b, (lo, hi) in BAND_EDGES.items()}

    window = np.hanning(frame).astype(np.float64)
    for i in range(n_frames):
        start = i * hop
        seg = audio[start : start + frame].astype(np.float64) * window
        mag = np.abs(np.fft.rfft(seg))
        for b, mask in band_masks.items():
            if mask.any():
                totals[b] += float(mag[mask].mean())

    means = {b: totals[b] / n_frames for b in bands}
    peak = max(means.values()) if means else 0.0
    if peak <= 0:
        return {b: 0.0 for b in bands}
    return {b: round(v / peak, 4) for b, v in means.items()}


def _rms_envelope(audio: np.ndarray, hop: int = HOP, frame: int = FRAME, target_points: int = 200) -> list[float]:
    """Downsampled RMS envelope of the whole track, ~target_points values."""
    n_frames = max(0, (len(audio) - frame) // hop + 1)
    if n_frames < 1:
        return []

    stride = max(1, n_frames // target_points)
    values: list[float] = []
    for i in range(0, n_frames, stride):
        start = i * hop
        seg = audio[start : start + frame]
        rms = float(np.sqrt(np.mean(np.square(seg, dtype=np.float64)))) if seg.size else 0.0
        values.append(rms)

    peak = max(values) if values else 0.0
    if peak > 0:
        values = [round(v / peak, 4) for v in values]
    return values


def _maybe_fingerprint(path: Path) -> dict:
    """AcoustID lookup, best-effort. Silent no-op if key/binary/network missing."""
    api_key = os.environ.get("ACOUSTID_API_KEY")
    fpcalc = shutil.which("fpcalc")
    if not api_key or not fpcalc:
        return {}

    try:
        proc = subprocess.run(
            [fpcalc, "-length", str(int(ACOUSTID_FINGERPRINT_SECONDS)), "-json", str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
            timeout=30,
        )
        import json as _json

        fp_data = _json.loads(proc.stdout.decode())
        fingerprint = fp_data.get("fingerprint")
        duration = fp_data.get("duration")
        if not fingerprint:
            return {}

        import urllib.parse
        import urllib.request

        query = urllib.parse.urlencode(
            {
                "client": api_key,
                "duration": int(duration or 0),
                "fingerprint": fingerprint,
                "meta": "recordings+releasegroups",
            }
        )
        url = f"https://api.acoustid.org/v2/lookup?{query}"
        with urllib.request.urlopen(url, timeout=10) as resp:
            result = _json.loads(resp.read().decode())

        results = result.get("results") or []
        for r in results:
            recordings = r.get("recordings") or []
            if recordings:
                rec = recordings[0]
                out = {}
                if rec.get("title"):
                    out["title"] = rec["title"]
                artists = rec.get("artists") or []
                if artists:
                    out["artist"] = artists[0].get("name")
                if out:
                    return out
        return {}
    except Exception:
        return {}


def analyze_file(path: Path) -> dict:
    """Analyze an audio file, gently. Cached by (path, mtime, size, analyzer version)."""
    path = Path(path)

    cached = load_analysis(path)
    if cached is not None:
        return cached

    try:
        os.nice(10)
    except (OSError, AttributeError):
        pass

    audio, sr = decode_mono_22k(path)
    duration_sec = len(audio) / float(sr) if sr else 0.0

    onset_env = _onset_envelope(audio)
    bpm, beats = _estimate_bpm(onset_env, sr)
    energy = _rms_envelope(audio)
    bands = _band_energies(audio, sr)

    result: dict = {
        "duration_sec": round(duration_sec, 3),
        "bpm": round(bpm, 2),
        "beats": beats,
        "energy": energy,
        "bands": bands,
        "sample_rate": sr,
    }

    fp_info = _maybe_fingerprint(path)
    result.update(fp_info)

    save_analysis(path, result)
    return result
