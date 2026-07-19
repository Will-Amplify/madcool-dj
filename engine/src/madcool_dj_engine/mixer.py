from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

from madcool_dj_engine.decode import load_stereo_44k


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


class DualDeckMixer:
    """Same-rate dual-deck mixer with seek/jog/cue and light rate nudge.

    Rate ≠ 1 uses sample-skip / hold (no heavy timestretch) — gentle on Tom.
    """

    def __init__(self, sr: int = 44100):
        self.sr = sr
        self.crossfade = 0.0
        self.decks: dict[str, Optional[DeckState]] = {"a": None, "b": None}

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

    def duration_sec(self, deck: str) -> float:
        state = self._deck(deck)
        if state is None:
            return 0.0
        return len(state.audio) / float(self.sr)

    def _apply_eq(self, block: np.ndarray, eq: DeckEQ) -> np.ndarray:
        """Crude 3-band EQ via moving-average split — cheap, not mastering-grade."""
        if eq.low == 1.0 and eq.mid == 1.0 and eq.high == 1.0:
            return block
        # ~200Hz / ~2kHz crossover at 44.1k with short MA windows
        k_low = 64
        k_high = 8
        low = np.zeros_like(block)
        for ch in range(2):
            kernel = np.ones(k_low, dtype=np.float32) / k_low
            low[:, ch] = np.convolve(block[:, ch], kernel, mode="same")
        residual = block - low
        high = np.zeros_like(block)
        for ch in range(2):
            kernel = np.ones(k_high, dtype=np.float32) / float(k_high)
            # high ≈ residual - smoothed residual
            smooth = np.convolve(residual[:, ch], kernel, mode="same")
            high[:, ch] = residual[:, ch] - smooth
        mid = residual - high
        return (low * eq.low + mid * eq.mid + high * eq.high).astype(np.float32)

    def mix_block(self, n_frames: int) -> np.ndarray:
        """Return (n_frames, 2) float32. Advance playing decks. Silence if empty."""
        out = np.zeros((n_frames, 2), dtype=np.float32)
        gain_a, gain_b = equal_power_gains(self.crossfade)
        deck_gains = {"a": gain_a, "b": gain_b}

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
                block = self._apply_eq(gathered[:wrote], state.eq)
                out[:wrote] += block * (deck_gains[name] * state.gain)

            if state.position >= len(state.audio):
                state.playing = False
                state.position = len(state.audio)

        return np.tanh(out).astype(np.float32)
