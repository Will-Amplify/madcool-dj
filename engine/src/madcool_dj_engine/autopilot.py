"""Autopilot: candidate scoring (`pick_next`) and the transition planner
(`Autopilot`) that drives it off the mixer's playback state.

`pick_next` is pure and synchronous — it's the part worth unit-testing hard.
`Autopilot` is the gentle, mostly-mechanical wiring: poll roughly once a
second from a daemon thread, and when the active deck's remaining time
drops under `horizon_sec`, plan once, load the pick on the opposite deck,
and ease the crossfade across. All the planning work (scoring, analysis)
happens off the realtime audio callback — `tick()` never touches
`mix_block`.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from madcool_dj_engine.analyze import analyze_file
from madcool_dj_engine.cache import load_analysis

logger = logging.getLogger(__name__)

DEFAULT_BPM_WINDOW = 0.06


def _band_l2_distance(a: dict, b: dict) -> float:
    """L2 distance over the union of band keys; a missing key on either side
    scores as 0.0 (silent) rather than raising — cache entries from an older
    analyzer version, or tracks with no cached analysis yet, shouldn't crash
    the planner.
    """
    keys = set(a.keys()) | set(b.keys())
    total = 0.0
    for key in keys:
        av = float(a.get(key) or 0.0)
        bv = float(b.get(key) or 0.0)
        diff = av - bv
        total += diff * diff
    return math.sqrt(total)


def _bpm_distance(current_bpm: float, track_bpm: float) -> float:
    """Fractional BPM distance, so it's roughly the same scale as the band
    L2 distance (bands are normalized 0..1) rather than dwarfing it.
    """
    if current_bpm <= 0:
        return abs(track_bpm - current_bpm)
    return abs(track_bpm - current_bpm) / current_bpm


def pick_next(
    current: dict,
    tracks: list[dict],
    recent: Optional[list[str]] = None,
    bpm_window: float = DEFAULT_BPM_WINDOW,
) -> Optional[dict]:
    """Pick the best next track to follow `current`.

    `current` needs `bpm` (float) and `bands` (dict of band -> 0..1 energy).
    Each entry in `tracks` needs `path`, `bpm`, and `bands`. Candidates
    missing a `path`/`bpm`, whose path is in `recent`, or whose BPM falls
    outside `bpm_window` (fraction, e.g. 0.06 = +/-6%) of `current`'s BPM are
    dropped before scoring — not merely penalized. Among the survivors, the
    lowest `bpm distance + band L2 distance` wins. Returns `None` if nothing
    survives the filters.
    """
    current_bpm = current.get("bpm")
    if not current_bpm:
        return None
    current_bands = current.get("bands") or {}
    recent_set = set(recent or [])

    lo = current_bpm * (1.0 - bpm_window)
    hi = current_bpm * (1.0 + bpm_window)

    best: Optional[dict] = None
    best_score = math.inf
    for track in tracks:
        path = track.get("path")
        if not path or path in recent_set:
            continue
        track_bpm = track.get("bpm")
        if not track_bpm or not (lo <= track_bpm <= hi):
            continue

        score = _bpm_distance(current_bpm, track_bpm) + _band_l2_distance(
            current_bands, track.get("bands") or {}
        )
        if score < best_score:
            best_score = score
            best = track

    return best


class Autopilot:
    """Polls the active deck and, once it's near its end, plans and starts
    the next track on the opposite deck.

    Not thread-safe against concurrent `tick()` calls, but that's fine: the
    background thread started by `enable()` is the only regular caller, and
    it never overlaps itself (one tick finishes before the next is
    scheduled). Tests call `tick()` directly instead of starting the thread,
    which keeps them deterministic.
    """

    TICK_INTERVAL_SEC = 1.0
    CROSSFADE_RAMP_SEC = 8.0
    CROSSFADE_STEPS = 16
    RECENT_LIMIT = 20

    def __init__(self, handler: Any, broadcast: Callable[[str, dict], None], horizon_sec: float = 45.0):
        self.handler = handler
        self.broadcast = broadcast
        self.horizon_sec = horizon_sec
        self.enabled = False
        self.recent: list[str] = []

        self._planned_for: Optional[str] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def enable(self) -> None:
        if self.enabled:
            return
        self.enabled = True
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def disable(self) -> None:
        self.enabled = False
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - a bad tick must not kill the thread
                logger.exception("autopilot tick failed")
            self._stop.wait(self.TICK_INTERVAL_SEC)

    # -- planning ---------------------------------------------------------

    def _active_deck(self):
        """The currently-playing deck, if any. If both are somehow playing
        (mid-manual-crossfade), the first one found wins — deterministic and
        good enough since autopilot backs off entirely once a human/agent is
        driving the crossfader directly.
        """
        decks = self.handler.mixer.decks
        for name in ("a", "b"):
            state = decks.get(name)
            if state is not None and state.playing:
                return name, state
        return None

    def _remaining_sec(self, state: Any) -> float:
        sr = self.handler.mixer.sr
        remaining_frames = max(0, len(state.audio) - state.position)
        return remaining_frames / float(sr)

    def _analysis_for(self, path: Path) -> Optional[dict]:
        cached = load_analysis(path)
        if cached is not None:
            return cached
        try:
            return analyze_file(path)
        except Exception:  # noqa: BLE001 - a bad candidate shouldn't stall planning
            logger.warning("autopilot: failed to analyze %s", path, exc_info=True)
            return None

    def _plan_next(self, active_path: str) -> Optional[dict]:
        current_analysis = self._analysis_for(Path(active_path))
        if current_analysis is None:
            return None
        current = {"bpm": current_analysis.get("bpm"), "bands": current_analysis.get("bands") or {}}

        candidates: list[dict] = []
        for entry in self.handler.library_index:
            path = entry.get("path")
            if not path or path == active_path:
                continue
            candidate_path = Path(path)
            if not candidate_path.exists():
                continue
            analysis = self._analysis_for(candidate_path)
            if analysis is None:
                continue
            candidates.append(
                {"path": path, "bpm": analysis.get("bpm"), "bands": analysis.get("bands") or {}}
            )

        return pick_next(current, candidates, recent=self.recent)

    # -- transition ---------------------------------------------------------

    def _start_crossfade_ramp(self, opposite_name: str) -> None:
        """Snap to a 50/50 blend immediately (so the transition audibly
        starts the moment the pick lands), then ease the rest of the way
        toward the opposite deck over `CROSSFADE_RAMP_SEC` in a daemon
        thread so `tick()` itself stays fast and off the audio callback.
        """
        mixer = self.handler.mixer
        target = 1.0 if opposite_name == "b" else 0.0
        mixer.set_crossfade(0.5)

        step_sleep = self.CROSSFADE_RAMP_SEC / self.CROSSFADE_STEPS

        def _ramp() -> None:
            for i in range(1, self.CROSSFADE_STEPS + 1):
                time.sleep(step_sleep)
                value = 0.5 + (target - 0.5) * (i / self.CROSSFADE_STEPS)
                mixer.set_crossfade(value)

        threading.Thread(target=_ramp, daemon=True).start()

    def tick(self) -> None:
        """If enabled and the active deck's remaining time is under the
        horizon, plan once per playthrough: pick a candidate from the
        library index + analysis cache, load/start it on the opposite deck,
        and kick off the crossfade ramp. A no-op in every other case
        (disabled, nothing playing, already planned for this track, or no
        acceptable candidate).
        """
        if not self.enabled:
            return

        active = self._active_deck()
        if active is None:
            return
        active_name, active_state = active
        opposite_name = "b" if active_name == "a" else "a"

        remaining = self._remaining_sec(active_state)
        if remaining > self.horizon_sec:
            return

        active_path = str(active_state.path)
        if self._planned_for == active_path:
            return

        plan = self._plan_next(active_path)
        self._planned_for = active_path  # one attempt per playthrough, hit or miss
        if plan is None:
            return

        next_path = plan["path"]
        self.handler.mixer.load(opposite_name, Path(next_path))
        self.handler.mixer.play(opposite_name)

        self.recent.append(active_path)
        del self.recent[: -self.RECENT_LIMIT]

        self._start_crossfade_ramp(opposite_name)

        self.broadcast(
            "plan",
            {
                "from": active_name,
                "to": opposite_name,
                "path": next_path,
                "bpm": plan.get("bpm"),
                "remaining_sec": round(remaining, 2),
                "ramp_sec": self.CROSSFADE_RAMP_SEC,
            },
        )
