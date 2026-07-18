from pathlib import Path

import numpy as np
import pytest

from madcool_dj_engine.autopilot import Autopilot, pick_next

# -- pick_next ------------------------------------------------------------


def test_prefers_close_bpm():
    current = {"bpm": 128, "bands": {"bass": 0.5}}
    tracks = [
        {"path": "a", "bpm": 140, "bands": {"bass": 0.5}},
        {"path": "b", "bpm": 129, "bands": {"bass": 0.55}},
    ]
    assert pick_next(current, tracks)["path"] == "b"


def test_excludes_recent():
    current = {"bpm": 128, "bands": {"bass": 0.5}}
    tracks = [
        {"path": "a", "bpm": 128, "bands": {"bass": 0.5}},
        {"path": "b", "bpm": 130, "bands": {"bass": 0.6}},
    ]
    # "a" is the closer match, but excluding it as "recent" should fall
    # through to "b" rather than returning None.
    assert pick_next(current, tracks)["path"] == "a"
    assert pick_next(current, tracks, recent=["a"])["path"] == "b"


def test_bpm_window_rejects_far():
    current = {"bpm": 128, "bands": {"bass": 0.5}}
    tracks = [{"path": "a", "bpm": 150, "bands": {"bass": 0.5}}]  # +17% — well outside +/-6%
    assert pick_next(current, tracks) is None
    # Same track becomes eligible once the window is widened.
    assert pick_next(current, tracks, bpm_window=0.2) is not None


def test_pick_next_returns_none_when_current_bpm_missing():
    assert pick_next({"bands": {}}, [{"path": "a", "bpm": 128, "bands": {}}]) is None


def test_pick_next_missing_band_key_scores_as_zero():
    current = {"bpm": 128, "bands": {"bass": 0.8, "hats": 0.1}}
    tracks = [
        {"path": "a", "bpm": 128, "bands": {"bass": 0.8}},  # no "hats" key at all
        {"path": "b", "bpm": 128, "bands": {"bass": 0.8, "hats": 0.1}},
    ]
    assert pick_next(current, tracks)["path"] == "b"


# -- Autopilot.tick, unit-tested against a fake handler -------------------


class _FakeDeck:
    def __init__(self, path, n_frames: int, playing: bool = True, position: int = 0):
        self.path = Path(path)
        self.audio = np.zeros((n_frames, 2), dtype=np.float32)
        self.position = position
        self.playing = playing
        self.gain = 1.0


class _FakeMixer:
    """Minimal stand-in for `DualDeckMixer` — just enough surface for
    `Autopilot.tick` (sr, decks, load/play/set_crossfade) without touching
    ffmpeg or real playback.
    """

    def __init__(self, sr: int = 44100):
        self.sr = sr
        self.crossfade = 0.0
        self.decks: dict[str, object] = {"a": None, "b": None}
        self.loaded: list[tuple[str, str]] = []
        self.played: list[str] = []

    def load(self, deck: str, path, start_sec: float = 0.0) -> None:
        self.loaded.append((deck, str(path)))
        self.decks[deck] = _FakeDeck(path, n_frames=44100 * 60)

    def play(self, deck: str) -> None:
        self.played.append(deck)
        if self.decks[deck] is not None:
            self.decks[deck].playing = True

    def set_crossfade(self, x: float) -> None:
        self.crossfade = x


class _FakeHandler:
    def __init__(self, mixer: _FakeMixer, library_index: list[dict]):
        self.mixer = mixer
        self.library_index = library_index


def _events_recorder():
    events: list[tuple[str, dict]] = []
    return events, (lambda event, data: events.append((event, data)))


def test_tick_noop_when_remaining_above_horizon(tmp_path: Path):
    active = tmp_path / "active.wav"
    active.write_bytes(b"")

    mixer = _FakeMixer()
    mixer.decks["a"] = _FakeDeck(active, n_frames=44100 * 120)  # 120s remaining
    handler = _FakeHandler(mixer, library_index=[{"path": str(tmp_path / "candidate.wav")}])
    events, broadcast = _events_recorder()

    ap = Autopilot(handler, broadcast, horizon_sec=45.0)
    ap.enabled = True
    ap.tick()

    assert mixer.loaded == []
    assert events == []


def test_tick_plans_and_loads_opposite_deck_within_horizon(tmp_path: Path, monkeypatch):
    active = tmp_path / "active.wav"
    far = tmp_path / "far.wav"
    close = tmp_path / "close.wav"
    for f in (active, far, close):
        f.write_bytes(b"")

    mixer = _FakeMixer()
    mixer.decks["a"] = _FakeDeck(active, n_frames=44100 * 10)  # 10s remaining, under horizon
    handler = _FakeHandler(
        mixer, library_index=[{"path": str(far)}, {"path": str(close)}]
    )

    analysis = {
        str(active): {"bpm": 128, "bands": {"bass": 0.5}},
        str(far): {"bpm": 150, "bands": {"bass": 0.5}},  # outside +/-6% window
        str(close): {"bpm": 129, "bands": {"bass": 0.52}},
    }
    monkeypatch.setattr(
        "madcool_dj_engine.autopilot.load_analysis",
        lambda p: analysis.get(str(p)),
    )

    events, broadcast = _events_recorder()
    ap = Autopilot(handler, broadcast, horizon_sec=45.0)
    ap.enabled = True
    ap.tick()

    assert mixer.loaded == [("b", str(close))]
    assert mixer.played == ["b"]
    assert mixer.crossfade == pytest.approx(0.5)  # immediate snap; ramp continues in background

    assert len(events) == 1
    event_name, data = events[0]
    assert event_name == "plan"
    assert data["from"] == "a"
    assert data["to"] == "b"
    assert data["path"] == str(close)


def test_tick_disabled_is_a_noop(tmp_path: Path, monkeypatch):
    active = tmp_path / "active.wav"
    active.write_bytes(b"")

    mixer = _FakeMixer()
    mixer.decks["a"] = _FakeDeck(active, n_frames=44100 * 10)
    handler = _FakeHandler(mixer, library_index=[])
    events, broadcast = _events_recorder()

    ap = Autopilot(handler, broadcast, horizon_sec=45.0)
    ap.enabled = False  # never enabled
    ap.tick()

    assert mixer.loaded == []
    assert events == []


def test_tick_only_plans_once_per_playthrough(tmp_path: Path, monkeypatch):
    active = tmp_path / "active.wav"
    close = tmp_path / "close.wav"
    for f in (active, close):
        f.write_bytes(b"")

    mixer = _FakeMixer()
    mixer.decks["a"] = _FakeDeck(active, n_frames=44100 * 10)
    handler = _FakeHandler(mixer, library_index=[{"path": str(close)}])

    analysis = {
        str(active): {"bpm": 128, "bands": {"bass": 0.5}},
        str(close): {"bpm": 129, "bands": {"bass": 0.5}},
    }
    monkeypatch.setattr(
        "madcool_dj_engine.autopilot.load_analysis",
        lambda p: analysis.get(str(p)),
    )

    events, broadcast = _events_recorder()
    ap = Autopilot(handler, broadcast, horizon_sec=45.0)
    ap.enabled = True

    ap.tick()
    ap.tick()  # deck "a" is still the first playing deck found — must not re-plan

    assert mixer.loaded == [("b", str(close))]
    assert len(events) == 1


def test_tick_no_plan_when_no_candidate_survives_window(tmp_path: Path, monkeypatch):
    active = tmp_path / "active.wav"
    far = tmp_path / "far.wav"
    for f in (active, far):
        f.write_bytes(b"")

    mixer = _FakeMixer()
    mixer.decks["a"] = _FakeDeck(active, n_frames=44100 * 10)
    handler = _FakeHandler(mixer, library_index=[{"path": str(far)}])

    analysis = {
        str(active): {"bpm": 128, "bands": {"bass": 0.5}},
        str(far): {"bpm": 150, "bands": {"bass": 0.5}},
    }
    monkeypatch.setattr(
        "madcool_dj_engine.autopilot.load_analysis",
        lambda p: analysis.get(str(p)),
    )

    events, broadcast = _events_recorder()
    ap = Autopilot(handler, broadcast, horizon_sec=45.0)
    ap.enabled = True
    ap.tick()

    assert mixer.loaded == []
    assert events == []
    # Guard still trips so we don't retry every tick for the rest of the playthrough.
    assert ap._planned_for == str(active)
