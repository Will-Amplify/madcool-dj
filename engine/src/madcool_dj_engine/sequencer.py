"""16-step sequencer — schedules pad/synth triggers off the audio clock."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field


def _clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


TrackName = str  # kick | snare | hat | clap | bass | fx


@dataclass
class StepSequencer:
    sr: int = 44100
    bpm: float = 140.0
    steps: int = 16
    playing: bool = False
    step_index: int = 0
    # patterns: track -> list[0/1] length steps
    patterns: dict[str, list[int]] = field(default_factory=dict)
    bass_notes: list[int] = field(default_factory=list)  # MIDI per step (0 = rest)
    swing: float = 0.0
    _phase_samples: float = 0.0
    on_pad: Callable[[str, float], None] | None = None
    on_bass: Callable[[int, float], None] | None = None
    on_bass_off: Callable[[], None] | None = None

    def __post_init__(self) -> None:
        defaults = {
            "kick": [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
            "snare": [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
            "hat": [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
            "clap": [0] * 16,
            "fx": [0] * 16,
        }
        for k, v in defaults.items():
            self.patterns.setdefault(k, list(v))
        if not self.bass_notes:
            # half-time root A1 on kicks
            self.bass_notes = [33 if i in (0, 8) else 0 for i in range(self.steps)]

    def samples_per_step(self) -> float:
        # 16th notes at bpm
        return (60.0 / max(40.0, self.bpm)) * self.sr / 4.0

    def set_bpm(self, bpm: float) -> None:
        self.bpm = _clamp(float(bpm), 60.0, 200.0)

    def set_pattern(self, track: str, steps: list[int]) -> None:
        if track not in self.patterns and track != "bass":
            self.patterns[track] = [0] * self.steps
        cleaned = [1 if int(s) else 0 for s in steps][: self.steps]
        while len(cleaned) < self.steps:
            cleaned.append(0)
        if track == "bass":
            # treat as gates; keep notes
            for i, g in enumerate(cleaned):
                if g and self.bass_notes[i] == 0:
                    self.bass_notes[i] = 33
                if not g:
                    self.bass_notes[i] = 0
        else:
            self.patterns[track] = cleaned

    def set_bass_notes(self, notes: list[int]) -> None:
        cleaned = [max(0, int(n)) for n in notes][: self.steps]
        while len(cleaned) < self.steps:
            cleaned.append(0)
        self.bass_notes = cleaned

    def play(self) -> None:
        self.playing = True

    def stop(self) -> None:
        self.playing = False
        self.step_index = 0
        self._phase_samples = 0.0
        if self.on_bass_off:
            self.on_bass_off()

    def clear(self) -> None:
        for k in list(self.patterns.keys()):
            self.patterns[k] = [0] * self.steps
        self.bass_notes = [0] * self.steps

    def snapshot(self) -> dict:
        return {
            "playing": self.playing,
            "bpm": self.bpm,
            "steps": self.steps,
            "step_index": self.step_index,
            "patterns": {k: list(v) for k, v in self.patterns.items()},
            "bass_notes": list(self.bass_notes),
            "swing": self.swing,
        }

    def advance(self, n_frames: int) -> None:
        """Call once per mix_block while playing — fires step callbacks."""
        if not self.playing:
            return
        sps = self.samples_per_step()
        if sps <= 1:
            return
        self._phase_samples += n_frames
        while self._phase_samples >= sps:
            self._phase_samples -= sps
            self._fire_step(self.step_index)
            self.step_index = (self.step_index + 1) % self.steps

    def _fire_step(self, idx: int) -> None:
        if self.on_pad:
            for track, pattern in self.patterns.items():
                if track == "fx":
                    if pattern[idx]:
                        self.on_pad("impact", 0.9)
                    continue
                if pattern[idx]:
                    self.on_pad(track, 1.0)
        note = self.bass_notes[idx] if idx < len(self.bass_notes) else 0
        if note > 0 and self.on_bass:
            self.on_bass(note, 1.0)
        elif note <= 0 and self.on_bass_off:
            self.on_bass_off()
