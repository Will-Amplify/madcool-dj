"""Studio bus: FX, wobble synth, sampler, sequencer."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from madcool_dj_engine.commands import EngineCommandHandler
from madcool_dj_engine.fx import MasterFX
from madcool_dj_engine.mixer import DualDeckMixer
from madcool_dj_engine.sequencer import StepSequencer
from madcool_dj_engine.synth import WobbleSynth

FIXTURE_KIT = Path(__file__).resolve().parents[2] / "fixtures" / "dubstep"


def test_fx_filter_changes_signal():
    fx = MasterFX(44100)
    x = np.random.randn(1024, 2).astype(np.float32) * 0.3
    fx.set(filter_hz=200.0, lfo_hz=0.0, lfo_depth=0.0)
    y = fx.process(x.copy())
    assert y.shape == x.shape
    assert float(np.mean(np.abs(y))) < float(np.mean(np.abs(x)))


def test_wobble_synth_renders_when_gated():
    s = WobbleSynth(44100)
    s.note_on(33, 1.0)
    block = s.render(512)
    assert block.shape == (512, 2)
    assert float(np.max(np.abs(block))) > 0.01
    s.note_off()
    # release still may have energy; after long render should decay
    for _ in range(40):
        block = s.render(512)
    assert float(np.max(np.abs(block))) < 0.05


def test_sequencer_fires_pads():
    hits: list[str] = []
    seq = StepSequencer(sr=44100, bpm=140, on_pad=lambda p, v: hits.append(p))
    seq.set_pattern("kick", [1] + [0] * 15)
    seq.play()
    # advance one full 16th
    sps = int(seq.samples_per_step()) + 1
    seq.advance(sps)
    assert "kick" in hits


def test_studio_kit_and_commands():
    mixer = DualDeckMixer()
    h = EngineCommandHandler(mixer)
    assert FIXTURE_KIT.is_dir()
    loaded = h.dispatch("studio.loadKit", {"path": str(FIXTURE_KIT)})
    assert loaded["pads"]
    assert "kick" in loaded["pads"]
    h.dispatch("sampler.trigger", {"pad": "kick", "velocity": 1})
    out = mixer.mix_block(1024)
    assert out.shape == (1024, 2)
    assert float(np.max(np.abs(out))) > 0.001

    h.dispatch("synth.noteOn", {"note": 33, "velocity": 1})
    out2 = mixer.mix_block(1024)
    assert float(np.max(np.abs(out2))) > 0.01

    h.dispatch("fx.set", {"filter_hz": 400.0, "lfo_hz": 4.0, "lfo_depth": 0.8})
    st = h.dispatch("status", {})
    assert "studio" in st
    assert st["fx"]["filter_hz"] == 400.0

    drop = h.dispatch("transition.run", {"name": "drop"})
    assert drop["ok"] is True

    h.dispatch("seq.setBpm", {"bpm": 140})
    h.dispatch("seq.play", {})
    mixer.mix_block(4096)
    snap = h.dispatch("studio.status", {})
    assert snap["seq"]["playing"] is True
    h.dispatch("seq.stop", {})
