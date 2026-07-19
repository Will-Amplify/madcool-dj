"""Intro cue selection from analysis (beats / energy) — used by autopilot."""

from __future__ import annotations

from typing import Any


def pick_intro_cue_sec(
    analysis: dict[str, Any] | None,
    *,
    prefer_after_sec: float = 0.4,
    search_window_sec: float = 32.0,
) -> float:
    """Pick a sensible load/start cue near the intro.

    Prefer the first beat after `prefer_after_sec`. Else the quietest energy
    bin in the first `search_window_sec`. Else 0.
    """
    if not analysis:
        return 0.0

    duration = float(analysis.get("duration_sec") or 0.0)
    beats = analysis.get("beats") or []
    if isinstance(beats, list) and beats:
        for b in beats:
            try:
                t = float(b)
            except (TypeError, ValueError):
                continue
            if t >= prefer_after_sec:
                if duration > 0:
                    return min(t, max(0.0, duration - 1.0))
                return max(0.0, t)

    energy = analysis.get("energy") or []
    if isinstance(energy, list) and len(energy) >= 8 and duration > 0:
        # energy bins span the whole track
        window = min(search_window_sec, duration)
        n_window = max(1, int(len(energy) * (window / duration)))
        region = energy[:n_window]
        # skip the absolute start (often silence/click) — search from ~5%
        start_i = max(1, n_window // 20)
        slice_ = region[start_i:] or region
        min_i = start_i + min(range(len(slice_)), key=lambda i: float(slice_[i] or 0.0))
        t = (min_i / max(1, len(energy) - 1)) * duration
        return max(prefer_after_sec, min(t, max(0.0, duration - 1.0)))

    return 0.0


def tempo_match_rate(current_bpm: float, next_bpm: float, *, clamp: float = 0.03) -> float:
    """Playback rate for `next` so it matches `current` tempo. Clamped ±clamp."""
    if current_bpm <= 0 or next_bpm <= 0:
        return 1.0
    ratio = float(current_bpm) / float(next_bpm)
    lo, hi = 1.0 - clamp, 1.0 + clamp
    if ratio < lo:
        return lo
    if ratio > hi:
        return hi
    return ratio
