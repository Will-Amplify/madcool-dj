"""Wobble bass synth — saw/square + resonant LFO filter. Cheap enough for Tom."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


def _clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def midi_to_hz(note: float) -> float:
    return 440.0 * (2.0 ** ((float(note) - 69.0) / 12.0))


@dataclass
class SynthParams:
    waveform: str = "saw"  # saw | square | sine
    gain: float = 0.55
    cutoff: float = 800.0
    resonance: float = 2.5
    lfo_hz: float = 4.67  # ~1/8 at 140 BPM
    lfo_depth: float = 0.85
    attack: float = 0.01
    release: float = 0.15


class WobbleSynth:
    def __init__(self, sr: int = 44100):
        self.sr = sr
        self.params = SynthParams()
        self._phase = 0.0
        self._lfo_phase = 0.0
        self._gate = False
        self._amp = 0.0
        self._target_amp = 0.0
        self._freq = midi_to_hz(33)  # A1-ish sub
        self._note = 33.0
        self._lp = 0.0

    def set(self, **kwargs: float | str) -> SynthParams:
        p = self.params
        for key, val in kwargs.items():
            if key == "waveform" and isinstance(val, str):
                p.waveform = val if val in ("saw", "square", "sine") else p.waveform
            elif hasattr(p, key) and key != "waveform":
                setattr(p, key, float(val))
        p.gain = _clamp(p.gain, 0.0, 1.5)
        p.cutoff = _clamp(p.cutoff, 60.0, 8000.0)
        p.resonance = _clamp(p.resonance, 0.5, 10.0)
        p.lfo_hz = _clamp(p.lfo_hz, 0.0, 16.0)
        p.lfo_depth = _clamp(p.lfo_depth, 0.0, 1.0)
        p.attack = _clamp(p.attack, 0.001, 1.0)
        p.release = _clamp(p.release, 0.01, 2.0)
        return p

    def note_on(self, note: float, velocity: float = 1.0) -> None:
        self._note = float(note)
        self._freq = midi_to_hz(note)
        self._gate = True
        self._target_amp = _clamp(float(velocity), 0.0, 1.0)

    def note_off(self) -> None:
        self._gate = False
        self._target_amp = 0.0

    def snapshot(self) -> dict:
        p = self.params
        return {
            "waveform": p.waveform,
            "gain": round(p.gain, 3),
            "cutoff": round(p.cutoff, 1),
            "resonance": round(p.resonance, 3),
            "lfo_hz": round(p.lfo_hz, 3),
            "lfo_depth": round(p.lfo_depth, 3),
            "attack": round(p.attack, 3),
            "release": round(p.release, 3),
            "gate": self._gate,
            "note": self._note,
            "freq_hz": round(self._freq, 2),
        }

    def render(self, n_frames: int) -> np.ndarray:
        out = np.zeros((n_frames, 2), dtype=np.float32)
        if self._amp < 1e-5 and self._target_amp <= 0.0 and not self._gate:
            return out

        p = self.params
        attack_c = 1.0 - math.exp(-1.0 / max(1, int(p.attack * self.sr)))
        release_c = 1.0 - math.exp(-1.0 / max(1, int(p.release * self.sr)))
        phase = self._phase
        lfo_phase = self._lfo_phase
        amp = self._amp
        lp = self._lp
        freq = self._freq
        two_pi = 2.0 * math.pi

        for i in range(n_frames):
            target = self._target_amp if self._gate else 0.0
            coeff = attack_c if target > amp else release_c
            amp += (target - amp) * coeff

            # oscillator
            ph = phase % 1.0
            if p.waveform == "square":
                osc = 1.0 if ph < 0.5 else -1.0
            elif p.waveform == "sine":
                osc = math.sin(two_pi * ph)
            else:  # saw
                osc = 2.0 * ph - 1.0
            phase += freq / self.sr

            # LFO → cutoff
            lfo = 0.5 * (1.0 + math.sin(lfo_phase))
            lfo_phase += two_pi * p.lfo_hz / self.sr
            cutoff = p.cutoff * (1.0 - p.lfo_depth * lfo)
            cutoff = 60.0 if cutoff < 60.0 else (8000.0 if cutoff > 8000.0 else cutoff)
            a = math.exp(-two_pi * cutoff / self.sr)
            # naive resonant soft clip
            driven = osc * (1.0 + (p.resonance - 1.0) * 0.15)
            lp = a * lp + (1.0 - a) * driven
            # mild waveshape for growl
            sample = math.tanh(lp * (1.0 + p.resonance * 0.2)) * amp * p.gain
            out[i, 0] = sample
            out[i, 1] = sample

        self._phase = phase % 1.0
        self._lfo_phase = lfo_phase % (two_pi)
        self._amp = amp
        self._lp = lp
        return out
