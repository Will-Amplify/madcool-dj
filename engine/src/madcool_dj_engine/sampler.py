"""One-shot pad sampler for drum/FX triggers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import numpy as np

from madcool_dj_engine.decode import load_stereo_44k

DEFAULT_PADS = ("kick", "snare", "hat", "openhat", "clap", "rim", "bass", "riser", "impact", "sweep", "noise", "kick2")


class PadSampler:
    def __init__(self, sr: int = 44100):
        self.sr = sr
        self.pads: dict[str, np.ndarray] = {}
        self.kit_path: Optional[Path] = None
        self._voices: list[dict] = []  # {audio, pos, gain}

    def load_kit(self, root: Path) -> dict:
        root = Path(root)
        kit_json = root / "kit.json"
        mapping: dict[str, str] = {}
        if kit_json.is_file():
            data = json.loads(kit_json.read_text())
            mapping = dict(data.get("pads") or {})
            self.kit_path = root
        else:
            # heuristic: drums/*.wav
            self.kit_path = root
            for wav in sorted(root.rglob("*.wav")):
                stem = wav.stem.lower()
                for pad in DEFAULT_PADS:
                    if pad in stem and pad not in mapping:
                        mapping[pad] = str(wav.relative_to(root))
        loaded = {}
        for pad, rel in mapping.items():
            path = root / rel
            if not path.is_file():
                continue
            audio = load_stereo_44k(path)
            self.pads[pad] = audio
            loaded[pad] = str(path)
        return {"kit": str(root), "pads": loaded}

    def load_pad(self, name: str, path: Path) -> None:
        self.pads[name] = load_stereo_44k(Path(path))

    def trigger(self, pad: str, velocity: float = 1.0) -> bool:
        audio = self.pads.get(pad)
        if audio is None:
            return False
        gain = 0.0 if velocity < 0 else (1.0 if velocity > 1 else float(velocity))
        self._voices.append({"audio": audio, "pos": 0, "gain": gain})
        # cap polyphony
        if len(self._voices) > 24:
            self._voices = self._voices[-24:]
        return True

    def snapshot(self) -> dict:
        return {
            "kit": str(self.kit_path) if self.kit_path else None,
            "pads": sorted(self.pads.keys()),
            "voices": len(self._voices),
        }

    def render(self, n_frames: int) -> np.ndarray:
        out = np.zeros((n_frames, 2), dtype=np.float32)
        alive: list[dict] = []
        for v in self._voices:
            audio = v["audio"]
            pos = v["pos"]
            gain = v["gain"]
            remain = len(audio) - pos
            if remain <= 0:
                continue
            n = min(n_frames, remain)
            out[:n] += audio[pos : pos + n] * gain
            v["pos"] = pos + n
            if v["pos"] < len(audio):
                alive.append(v)
        self._voices = alive
        return out
