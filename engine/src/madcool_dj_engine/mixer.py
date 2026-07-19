from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

from madcool_dj_engine.decode import load_stereo_44k
from madcool_dj_engine.studio import StudioBus


def equal_power_gains(x: float) -> Tuple[float, float]:
    """x in [0,1]: 0 = full A, 1 = full B."""
    x = 0.0 if x < 0 else 1.0 if x > 1 else float(x)
    a = math.cos(x * math.pi / 2)
    b = math.sin(x * math.pi / 2)
    return a, b


def _clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


@dataclass
class DeckEQ:
    """Gentle 3-band shelf gains in linear amplitude (1.0 = flat)."""

    low: float = 1.0
    mid: float = 1.0
    high: float = 1.0


@dataclass
class DeckState:
    path: Path
    audio: np.ndarray  # (n, 2) float32
    position: int = 0
    playing: bool = False
    gain: float = 1.0
    cue_frame: int = 0
    rate: float = 1.0  # 0.92 .. 1.08 playback rate (sample skip/hold)
    eq: DeckEQ = field(default_factory=DeckEQ)
    source: str = "local"
    title: str = ""
    # fractional position accumulator for non-integer rates
    _phase: float = 0.0
    # one-pole EQ state: [lp, hp] per channel
    _eq_lp: np.ndarray = field(default_factory=lambda: np.zeros(2, dtype=np.float64))
    _eq_hp: np.ndarray = field(default_factory=lambda: np.zeros(2, dtype=np.float64))


class DualDeckMixer:
    """Same-rate dual-deck mixer with seek/jog/cue and light rate nudge.

    Rate ≠ 1 uses sample-skip / hold (no heavy timestretch) — gentle on Tom.
    """

    def __init__(self, sr: int = 44100):
        self.sr = sr
        self.crossfade = 0.0
        self.decks: dict[str, Optional[DeckState]] = {"a": None, "b": None}
        self.studio = StudioBus(sr)
        self.last_levels: dict[str, float] = {
            "peak_l": 0.0,
            "peak_r": 0.0,
            "deck_a": 0.0,
            "deck_b": 0.0,
        }
        self._ramp_stop = threading.Event()
        self._ramp_stop.set()  # no ramp active
        # one-pole coeffs (~200 Hz / ~2 kHz at 44.1k)
        self._eq_a_lp = math.exp(-2.0 * math.pi * 200.0 / sr)
        self._eq_a_hp = math.exp(-2.0 * math.pi * 2000.0 / sr)

    def _deck(self, deck: str) -> Optional[DeckState]:
        if deck not in self.decks:
            raise ValueError(f"unknown deck: {deck!r} (expected 'a' or 'b')")
        return self.decks[deck]

    def _require(self, deck: str) -> DeckState:
        state = self._deck(deck)
        if state is None:
            raise ValueError(f"deck {deck!r} is empty")
        return state

    def load(
        self,
        deck: str,
        path: Path,
        start_sec: float = 0.0,
        *,
        source: str = "local",
        title: str = "",
    ) -> None:
        self._deck(deck)
        audio = load_stereo_44k(path)
        start_frame = min(len(audio), max(0, int(round(start_sec * self.sr))))
        name = title or Path(path).stem
        self.decks[deck] = DeckState(
            path=Path(path),
            audio=audio,
            position=start_frame,
            cue_frame=start_frame,
            source=source,
            title=name,
        )

    def play(self, deck: str) -> None:
        state = self._deck(deck)
        if state is not None:
            state.playing = True

    def pause(self, deck: str) -> None:
        state = self._deck(deck)
        if state is not None:
            state.playing = False

    def seek(self, deck: str, position_sec: float) -> None:
        state = self._require(deck)
        frame = int(round(position_sec * self.sr))
        state.position = max(0, min(len(state.audio) - 1, frame))
        state._phase = 0.0

    def jog(self, deck: str, delta_sec: float) -> None:
        state = self._require(deck)
        self.seek(deck, state.position / float(self.sr) + delta_sec)

    def waveform(self, deck: str, bins: int = 256) -> list[float]:
        """RMS overview of the loaded buffer (for deck canvas waveforms)."""
        from madcool_dj_engine.audio_out import energy_bins_from_audio

        state = self._require(deck)
        n = max(4, min(1024, int(bins)))
        return energy_bins_from_audio(state.audio, bins=n)

    def set_cue(self, deck: str, position_sec: float | None = None) -> None:
        state = self._require(deck)
        if position_sec is None:
            state.cue_frame = state.position
        else:
            frame = int(round(position_sec * self.sr))
            state.cue_frame = max(0, min(len(state.audio) - 1, frame))

    def cue(self, deck: str) -> None:
        """Jump to cue. If playing, pause at cue (Serato-style back-cue)."""
        state = self._require(deck)
        state.position = state.cue_frame
        state._phase = 0.0
        state.playing = False

    def set_rate(self, deck: str, rate: float) -> None:
        state = self._require(deck)
        state.rate = _clamp(float(rate), 0.92, 1.08)

    def nudge_rate(self, deck: str, delta: float) -> None:
        state = self._require(deck)
        self.set_rate(deck, state.rate + delta)

    def set_gain(self, deck: str, gain: float) -> None:
        state = self._require(deck)
        state.gain = _clamp(float(gain), 0.0, 2.0)

    def set_eq(self, deck: str, *, low: float | None = None, mid: float | None = None, high: float | None = None) -> None:
        state = self._require(deck)
        if low is not None:
            state.eq.low = _clamp(float(low), 0.0, 2.0)
        if mid is not None:
            state.eq.mid = _clamp(float(mid), 0.0, 2.0)
        if high is not None:
            state.eq.high = _clamp(float(high), 0.0, 2.0)

    def set_crossfade(self, x: float) -> None:
        self.crossfade = _clamp(float(x), 0.0, 1.0)

    def cancel_crossfade_ramp(self) -> None:
        self._ramp_stop.set()

    def ramp_crossfade(self, target: float, duration_sec: float = 4.0, steps: int = 24) -> None:
        """Ease crossfade toward `target` off the audio callback. Cancels any prior ramp."""
        target = _clamp(float(target), 0.0, 1.0)
        duration_sec = max(0.05, float(duration_sec))
        steps = max(2, int(steps))
        self._ramp_stop.set()
        stop = threading.Event()
        self._ramp_stop = stop
        start = self.crossfade
        step_sleep = duration_sec / steps

        def _ramp() -> None:
            for i in range(1, steps + 1):
                if stop.is_set():
                    return
                time.sleep(step_sleep)
                if stop.is_set():
                    return
                self.set_crossfade(start + (target - start) * (i / steps))

        threading.Thread(target=_ramp, daemon=True, name="xfade-ramp").start()

    def duration_sec(self, deck: str) -> float:
        state = self._deck(deck)
        if state is None:
            return 0.0
        return len(state.audio) / float(self.sr)

    def _apply_eq(self, block: np.ndarray, state: DeckState) -> np.ndarray:
        """Stateful one-pole 3-band split via lfilter — flat EQ is a no-op."""
        from scipy.signal import lfilter

        eq = state.eq
        if eq.low == 1.0 and eq.mid == 1.0 and eq.high == 1.0:
            return block
        x = np.asarray(block, dtype=np.float64)
        a_lp = self._eq_a_lp
        a_hp = self._eq_a_hp
        b_lp = np.array([1.0 - a_lp])
        a_lp_c = np.array([1.0, -a_lp])
        b_hp = np.array([1.0 - a_hp])
        a_hp_c = np.array([1.0, -a_hp])
        out = np.empty_like(x)
        for ch in range(2):
            low, z_lp = lfilter(b_lp, a_lp_c, x[:, ch], zi=[state._eq_lp[ch]])
            residual = x[:, ch] - low
            smooth, z_hp = lfilter(b_hp, a_hp_c, residual, zi=[state._eq_hp[ch]])
            high = residual - smooth
            mid = residual - high
            out[:, ch] = low * eq.low + mid * eq.mid + high * eq.high
            state._eq_lp[ch] = float(z_lp[0])
            state._eq_hp[ch] = float(z_hp[0])
        return out.astype(np.float32)

    def mix_block(self, n_frames: int) -> np.ndarray:
        """Return (n_frames, 2) float32. Advance playing decks. Silence if empty."""
        out = np.zeros((n_frames, 2), dtype=np.float32)
        gain_a, gain_b = equal_power_gains(self.crossfade)
        deck_gains = {"a": gain_a, "b": gain_b}
        deck_peaks = {"a": 0.0, "b": 0.0}

        for name, state in self.decks.items():
            if state is None or not state.playing:
                continue

            rate = state.rate if state.rate > 0 else 1.0
            gathered = np.zeros((n_frames, 2), dtype=np.float32)
            wrote = 0
            while wrote < n_frames and state.position < len(state.audio):
                gathered[wrote] = state.audio[state.position]
                wrote += 1
                state._phase += rate
                step = int(state._phase)
                if step > 0:
                    state.position += step
                    state._phase -= step

            if wrote > 0:
                block = self._apply_eq(gathered[:wrote], state)
                scaled = block * (deck_gains[name] * state.gain)
                out[:wrote] += scaled
                deck_peaks[name] = float(np.max(np.abs(scaled))) if scaled.size else 0.0

            if state.position >= len(state.audio):
                state.playing = False
                state.position = len(state.audio)

        # Studio bus (sampler + synth + seq) summed pre-FX, then master FX
        out += self.studio.render(n_frames)
        out = self.studio.fx.process(out)
        out = np.tanh(out).astype(np.float32)
        self.last_levels = {
            "peak_l": float(np.max(np.abs(out[:, 0]))) if len(out) else 0.0,
            "peak_r": float(np.max(np.abs(out[:, 1]))) if len(out) else 0.0,
            "deck_a": deck_peaks["a"],
            "deck_b": deck_peaks["b"],
        }
        return out
