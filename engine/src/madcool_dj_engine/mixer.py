from __future__ import annotations

import math
from dataclasses import dataclass
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


@dataclass
class DeckState:
    path: Path
    audio: np.ndarray  # (n, 2) float32
    position: int = 0
    playing: bool = False
    gain: float = 1.0


class DualDeckMixer:
    """Same-rate dual-deck mixer. No realtime resample in v1 — decks must
    already be at `sr`, which `load()` guarantees via `load_stereo_44k`.
    """

    def __init__(self, sr: int = 44100):
        self.sr = sr
        self.crossfade = 0.0
        self.decks: dict[str, Optional[DeckState]] = {"a": None, "b": None}

    def _deck(self, deck: str) -> Optional[DeckState]:
        if deck not in self.decks:
            raise ValueError(f"unknown deck: {deck!r} (expected 'a' or 'b')")
        return self.decks[deck]

    def load(self, deck: str, path: Path, start_sec: float = 0.0) -> None:
        self._deck(deck)
        audio = load_stereo_44k(path)
        start_frame = min(len(audio), max(0, int(round(start_sec * self.sr))))
        self.decks[deck] = DeckState(path=Path(path), audio=audio, position=start_frame)

    def play(self, deck: str) -> None:
        state = self._deck(deck)
        if state is not None:
            state.playing = True

    def pause(self, deck: str) -> None:
        state = self._deck(deck)
        if state is not None:
            state.playing = False

    def set_crossfade(self, x: float) -> None:
        self.crossfade = 0.0 if x < 0 else 1.0 if x > 1 else float(x)

    def mix_block(self, n_frames: int) -> np.ndarray:
        """Return (n_frames, 2) float32. Advance playing decks. Silence if empty."""
        out = np.zeros((n_frames, 2), dtype=np.float32)
        gain_a, gain_b = equal_power_gains(self.crossfade)
        deck_gains = {"a": gain_a, "b": gain_b}

        for name, state in self.decks.items():
            if state is None or not state.playing:
                continue
            remaining = len(state.audio) - state.position
            take = max(0, min(n_frames, remaining))
            if take > 0:
                block = state.audio[state.position : state.position + take]
                out[:take] += block * (deck_gains[name] * state.gain)
                state.position += take
            if state.position >= len(state.audio):
                state.playing = False

        return np.tanh(out).astype(np.float32)
