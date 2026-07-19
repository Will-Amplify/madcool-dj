"""Master FX chain for the mix bus — vectorized IIR + delay, Tom-friendly."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.signal import lfilter

# Bypass filter when cutoff is at/above this (default 18 kHz = open).
FILTER_BYPASS_HZ = 18000.0


def _clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


@dataclass
class FXParams:
    enabled: bool = True
    filter_hz: float = 18000.0
    filter_res: float = 0.7
    lfo_hz: float = 0.0
    lfo_depth: float = 0.0
    delay_ms: float = 0.0
    delay_fb: float = 0.25
    delay_mix: float = 0.0
    crush: float = 0.0


class MasterFX:
    """Stateful stereo FX applied after deck/synth/sampler sum."""

    def __init__(self, sr: int = 44100):
        self.sr = sr
        self.params = FXParams()
        self._lfo_phase = 0.0
        self._lp_state = np.zeros(2, dtype=np.float64)
        max_delay = int(sr * 2.0)
        self._delay_buf = np.zeros((max_delay, 2), dtype=np.float32)
        self._delay_idx = 0
        self._delay_len = max_delay

    def set(self, **kwargs: float | bool) -> FXParams:
        p = self.params
        for key, val in kwargs.items():
            if not hasattr(p, key):
                continue
            cur = getattr(p, key)
            if isinstance(cur, bool):
                setattr(p, key, bool(val))
            else:
                setattr(p, key, float(val))
        p.filter_hz = _clamp(p.filter_hz, 40.0, 20000.0)
        p.filter_res = _clamp(p.filter_res, 0.1, 8.0)
        p.lfo_hz = _clamp(p.lfo_hz, 0.0, 20.0)
        p.lfo_depth = _clamp(p.lfo_depth, 0.0, 1.0)
        p.delay_ms = _clamp(p.delay_ms, 0.0, 1500.0)
        p.delay_fb = _clamp(p.delay_fb, 0.0, 0.95)
        p.delay_mix = _clamp(p.delay_mix, 0.0, 1.0)
        p.crush = _clamp(p.crush, 0.0, 1.0)
        return p

    def snapshot(self) -> dict:
        p = self.params
        return {
            "enabled": p.enabled,
            "filter_hz": round(p.filter_hz, 1),
            "filter_res": round(p.filter_res, 3),
            "lfo_hz": round(p.lfo_hz, 3),
            "lfo_depth": round(p.lfo_depth, 3),
            "delay_ms": round(p.delay_ms, 1),
            "delay_fb": round(p.delay_fb, 3),
            "delay_mix": round(p.delay_mix, 3),
            "crush": round(p.crush, 3),
        }

    def process(self, block: np.ndarray) -> np.ndarray:
        if not self.params.enabled or block.size == 0:
            return block
        x = np.asarray(block, dtype=np.float32)
        p = self.params
        n = len(x)

        filter_engaged = p.filter_hz < FILTER_BYPASS_HZ or (p.lfo_hz > 0.0 and p.lfo_depth > 0.0)
        if filter_engaged:
            mid = n * 0.5 / self.sr
            lfo = 0.5 * (1.0 + math.sin(self._lfo_phase + 2.0 * math.pi * p.lfo_hz * mid))
            self._lfo_phase = (self._lfo_phase + 2.0 * math.pi * p.lfo_hz * n / self.sr) % (2.0 * math.pi)
            cutoff = p.filter_hz * (1.0 - p.lfo_depth * lfo)
            cutoff = _clamp(cutoff, 40.0, 20000.0)
            a = math.exp(-2.0 * math.pi * cutoff / self.sr)
            if p.filter_res > 1.0:
                bright = x - float(self._lp_state.mean())
                x = (x + bright * ((p.filter_res - 1.0) * 0.12)).astype(np.float32)
            alpha = 1.0 - a
            # y[n] = a*y[n-1] + alpha*x[n] via scipy (vectorized, keeps zi)
            y = np.empty_like(x, dtype=np.float64)
            b = np.array([alpha], dtype=np.float64)
            a_coeffs = np.array([1.0, -a], dtype=np.float64)
            for ch in range(2):
                out_ch, zf = lfilter(b, a_coeffs, x[:, ch].astype(np.float64), zi=[self._lp_state[ch]])
                y[:, ch] = out_ch
                self._lp_state[ch] = float(zf[0])
            x = y.astype(np.float32)

        if p.delay_mix > 0.0 and p.delay_ms > 1.0:
            d = max(1, min(int(p.delay_ms * 0.001 * self.sr), self._delay_len - 1))
            wet = np.empty_like(x)
            idx = self._delay_idx
            buf = self._delay_buf
            fb = p.delay_fb
            for i in range(n):
                ri = (idx - d) % self._delay_len
                delayed = buf[ri]
                wet[i] = delayed
                buf[idx] = x[i] + delayed * fb
                idx = (idx + 1) % self._delay_len
            self._delay_idx = idx
            mix = p.delay_mix
            x = x * (1.0 - mix) + wet * mix

        if p.crush > 0.01:
            levels = max(2.0, 2.0 ** (8.0 * (1.0 - p.crush) + 2.0))
            x = (np.round(x * levels) / levels).astype(np.float32)

        return x.astype(np.float32, copy=False)
