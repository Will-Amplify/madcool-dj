"""Studio bus: sampler + wobble synth + sequencer + master FX on the mix path."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from madcool_dj_engine.fx import MasterFX
from madcool_dj_engine.sampler import PadSampler
from madcool_dj_engine.sequencer import StepSequencer
from madcool_dj_engine.synth import WobbleSynth


class StudioBus:
    def __init__(self, sr: int = 44100):
        self.sr = sr
        self.fx = MasterFX(sr)
        self.synth = WobbleSynth(sr)
        self.sampler = PadSampler(sr)
        self.seq = StepSequencer(
            sr=sr,
            on_pad=self._on_pad,
            on_bass=self._on_bass,
            on_bass_off=self._on_bass_off,
        )
        self.studio_gain = 1.0

    def _on_pad(self, pad: str, velocity: float) -> None:
        # map sequencer track names to pads
        alias = {"hat": "hat", "openhat": "openhat"}
        name = alias.get(pad, pad)
        if not self.sampler.trigger(name, velocity):
            # try common fallbacks
            for alt in (f"{name}", "kick", "snare"):
                if self.sampler.trigger(alt, velocity):
                    break

    def _on_bass(self, note: int, velocity: float) -> None:
        self.synth.note_on(note, velocity)

    def _on_bass_off(self) -> None:
        self.synth.note_off()

    def load_default_kit(self) -> dict:
        candidates = [
            Path.home() / "Music" / "dj-library" / "dubstep",
            Path(__file__).resolve().parents[3] / "fixtures" / "dubstep",
        ]
        for root in candidates:
            if (root / "kit.json").is_file() or any(root.glob("**/*.wav")):
                return self.sampler.load_kit(root)
        return {"kit": None, "pads": {}}

    def transition(self, name: str) -> dict:
        """Dubstep transition macros — mutate FX (+ optional pad trigger)."""
        name = (name or "").lower().strip()
        if name in ("drop", "drop_filter"):
            self.fx.set(filter_hz=180.0, lfo_hz=0.0, lfo_depth=0.0, crush=0.05, delay_mix=0.1, delay_ms=375.0)
            self.sampler.trigger("impact", 1.0)
        elif name in ("build", "buildup"):
            self.fx.set(filter_hz=400.0, lfo_hz=0.25, lfo_depth=0.7, delay_mix=0.25, delay_ms=187.0, crush=0.0)
            self.sampler.trigger("riser", 0.85)
        elif name in ("wobble", "wob"):
            self.fx.set(filter_hz=1200.0, lfo_hz=4.67, lfo_depth=0.9, delay_mix=0.05)
            self.synth.set(lfo_hz=4.67, lfo_depth=0.9, cutoff=900.0)
            self.synth.note_on(33, 1.0)
        elif name in ("filter_sweep", "sweep"):
            self.fx.set(filter_hz=200.0, lfo_hz=0.15, lfo_depth=0.95)
            self.sampler.trigger("sweep", 0.8)
        elif name in ("crush", "destroy"):
            self.fx.set(crush=0.55, filter_hz=2500.0, delay_mix=0.2, delay_ms=90.0)
        elif name in ("clean", "reset"):
            self.fx.set(
                filter_hz=18000.0,
                lfo_hz=0.0,
                lfo_depth=0.0,
                delay_ms=0.0,
                delay_mix=0.0,
                crush=0.0,
                filter_res=0.7,
            )
            self.synth.note_off()
        else:
            return {"ok": False, "error": f"unknown_transition: {name}"}
        return {"ok": True, "transition": name, "fx": self.fx.snapshot()}

    def snapshot(self) -> dict[str, Any]:
        return {
            "fx": self.fx.snapshot(),
            "synth": self.synth.snapshot(),
            "sampler": self.sampler.snapshot(),
            "seq": self.seq.snapshot(),
            "studio_gain": self.studio_gain,
        }

    def render(self, n_frames: int) -> np.ndarray:
        self.seq.advance(n_frames)
        out = self.sampler.render(n_frames)
        out += self.synth.render(n_frames)
        if self.studio_gain != 1.0:
            out *= self.studio_gain
        return out
