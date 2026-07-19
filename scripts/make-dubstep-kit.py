#!/usr/bin/env python3
"""Regenerate the procedural MadCool dubstep kit into fixtures/dubstep and ~/Music/dj-library/dubstep."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from scipy.io import wavfile

SR = 44100
ROOT = Path(__file__).resolve().parents[1]
TARGETS = [
    ROOT / "fixtures" / "dubstep",
    Path.home() / "Music" / "dj-library" / "dubstep",
]


def write(path: Path, mono: np.ndarray) -> None:
    mono = np.asarray(mono, dtype=np.float64)
    peak = np.max(np.abs(mono)) or 1.0
    mono = (mono / peak * 0.89).astype(np.float32)
    stereo = np.stack([mono, mono], axis=1)
    pcm = np.clip(stereo * 32767.0, -32768, 32767).astype(np.int16)
    path.parent.mkdir(parents=True, exist_ok=True)
    wavfile.write(str(path), SR, pcm)


def env_exp(n: int, attack: float = 0.002, decay: float = 0.2) -> np.ndarray:
    a = int(attack * SR)
    e = np.ones(n, dtype=np.float64)
    if a > 0:
        e[:a] = np.linspace(0, 1, a)
    e[a:] *= np.exp(-np.linspace(0, 1, n - a) * (1.0 / max(decay, 1e-3)))
    return e


def build_into(out: Path) -> None:
    rng = np.random.default_rng(140)
    for sub in ("drums", "fx", "bass", "loops"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    def kick(name: str, f0: float, click: float, length: float) -> None:
        n = int(SR * length)
        t = np.arange(n) / SR
        freq = f0 * np.exp(-t * 18) + 28
        phase = 2 * np.pi * np.cumsum(freq) / SR
        body = np.sin(phase) * env_exp(n, 0.001, 0.28)
        click_n = int(0.004 * SR)
        clk = rng.uniform(-1, 1, click_n) * env_exp(click_n, 0.0002, 0.004) * click
        sig = body
        sig[:click_n] += clk
        write(out / "drums" / name, sig)

    def snare(name: str, tone: float, noise: float, length: float = 0.28) -> None:
        n = int(SR * length)
        t = np.arange(n) / SR
        body = np.sin(2 * np.pi * tone * t) * env_exp(n, 0.001, 0.08) * 0.45
        nz = rng.normal(0, 1, n) * env_exp(n, 0.0005, 0.12) * noise
        write(out / "drums" / name, body + nz)

    def hat(name: str, length: float, bright: float) -> None:
        n = int(SR * length)
        nz = rng.normal(0, 1, n)
        hp = np.diff(nz, prepend=0) * bright
        write(out / "drums" / name, hp * env_exp(n, 0.0003, length * 0.6))

    def clap(name: str) -> None:
        n = int(SR * 0.22)
        sig = np.zeros(n)
        for delay in (0, 0.012, 0.024, 0.038):
            d = int(delay * SR)
            burst = int(0.018 * SR)
            if d + burst < n:
                b = rng.normal(0, 1, burst) * env_exp(burst, 0.0005, 0.02)
                sig[d : d + burst] += b
        write(out / "drums" / name, sig)

    kick("kick_sub.wav", 45, 0.6, 0.5)
    kick("kick_punch.wav", 55, 1.2, 0.4)
    kick("kick_hard.wav", 62, 1.6, 0.35)
    snare("snare_crack.wav", 200, 0.85)
    snare("snare_deep.wav", 155, 0.55, 0.35)
    snare("snare_rim.wav", 320, 0.35, 0.12)
    hat("hat_closed.wav", 0.06, 1.2)
    hat("hat_closed_2.wav", 0.045, 1.5)
    hat("hat_open.wav", 0.28, 0.9)
    clap("clap_wide.wav")
    clap("clap_tight.wav")

    def riser(name: str, length: float, start: float, end: float) -> None:
        n = int(SR * length)
        t = np.arange(n) / SR
        freq = start * (end / start) ** (t / length)
        phase = 2 * np.pi * np.cumsum(freq) / SR
        tone = np.sin(phase) * 0.35
        noise = rng.normal(0, 1, n) * 0.25
        amp = (t / length) ** 1.4
        write(out / "fx" / name, (tone + noise) * amp)

    def impact(name: str) -> None:
        n = int(SR * 1.2)
        t = np.arange(n) / SR
        boom = np.sin(2 * np.pi * np.cumsum(55 * np.exp(-t * 8)) / SR) * env_exp(n, 0.002, 0.6)
        crash = rng.normal(0, 1, n) * env_exp(n, 0.001, 0.5) * 0.5
        write(out / "fx" / name, boom + crash)

    def sweep(name: str, down: bool) -> None:
        n = int(SR * 2.0)
        t = np.arange(n) / SR
        if down:
            freq = 8000 * (80 / 8000) ** (t / 2.0)
        else:
            freq = 80 * (8000 / 80) ** (t / 2.0)
        phase = 2 * np.pi * np.cumsum(freq) / SR
        write(out / "fx" / name, np.sin(phase) * 0.4 * env_exp(n, 0.01, 1.5))

    riser("riser_4bar.wav", 4.0, 150, 7000)
    riser("riser_2bar.wav", 2.0, 300, 8000)
    impact("impact_boom.wav")
    impact("impact_hit.wav")
    sweep("sweep_up.wav", False)
    sweep("sweep_down.wav", True)
    n = int(SR * 1.5)
    write(out / "fx" / "noise_down.wav", rng.normal(0, 1, n) * np.linspace(1, 0, n) ** 0.7 * 0.5)

    def growl(name: str, f0: float, length: float) -> None:
        n = int(SR * length)
        t = np.arange(n) / SR
        mod = np.sin(2 * np.pi * 4.5 * t)
        carrier = np.sin(2 * np.pi * f0 * t + 3.5 * mod * np.sin(2 * np.pi * f0 * 2 * t))
        sig = carrier
        for h, a in ((2, 0.35), (3, 0.2), (5, 0.12)):
            sig = sig + a * np.sin(2 * np.pi * f0 * h * t + mod)
        write(out / "bass" / name, sig * env_exp(n, 0.01, 0.7))

    for i, f in enumerate([41.2, 46.25, 55.0, 61.74, 73.42]):
        growl(f"growl_{i + 1}.wav", f, 1.2)
    growl("wobble_loop_oneshot.wav", 55, 2.0)

    bpm = 140.0
    bar = 60.0 / bpm * 4
    loop = np.zeros(int(SR * bar))

    def to_mono(x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype=np.float64)
        if x.ndim == 2:
            x = x.mean(axis=1)
        return x / 32768.0

    kick_m = to_mono(wavfile.read(str(out / "drums" / "kick_punch.wav"))[1])
    snare_m = to_mono(wavfile.read(str(out / "drums" / "snare_crack.wav"))[1])
    hat_m = to_mono(wavfile.read(str(out / "drums" / "hat_closed.wav"))[1])

    def place(dst: np.ndarray, src: np.ndarray, beat: float) -> None:
        pos = int(beat * (60.0 / bpm) * SR)
        end = min(len(dst), pos + len(src))
        dst[pos:end] += src[: end - pos]

    place(loop, kick_m * 0.9, 0)
    place(loop, snare_m * 0.85, 2)
    place(loop, kick_m * 0.5, 2.5)
    for b in np.arange(0, 4, 0.5):
        place(loop, hat_m * 0.35, float(b))
    write(out / "loops" / "beat_halftime_140.wav", loop)

    kit = {
        "name": "madcool-dubstep",
        "bpm": 140,
        "pads": {
            "kick": "drums/kick_punch.wav",
            "kick2": "drums/kick_hard.wav",
            "snare": "drums/snare_crack.wav",
            "clap": "drums/clap_wide.wav",
            "hat": "drums/hat_closed.wav",
            "openhat": "drums/hat_open.wav",
            "rim": "drums/snare_rim.wav",
            "bass": "bass/growl_3.wav",
            "riser": "fx/riser_2bar.wav",
            "impact": "fx/impact_boom.wav",
            "sweep": "fx/sweep_up.wav",
            "noise": "fx/noise_down.wav",
        },
    }
    (out / "kit.json").write_text(json.dumps(kit, indent=2) + "\n")
    (out / "LICENSE.txt").write_text(
        "MadCool procedural dubstep kit — original synthesis for MadCool DJ.\n"
        "Free to use in MadCool projects.\n"
    )


def main() -> None:
    for target in TARGETS:
        build_into(target)
        print(f"wrote {target}")


if __name__ == "__main__":
    main()
