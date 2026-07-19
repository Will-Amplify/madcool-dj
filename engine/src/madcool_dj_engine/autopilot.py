"""Autopilot: candidate scoring (`pick_next`) and the transition planner
(`Autopilot`) that drives it off the mixer's playback state.

`pick_next` is pure and synchronous — it's the part worth unit-testing hard.
`Autopilot` is the gentle, mostly-mechanical wiring: poll roughly once a
second from a daemon thread, and when the active deck's remaining time
drops under `horizon_sec`, plan once, load the pick on the opposite deck
(beatmatched ±3%, intro cue), and ease the crossfade across. All the
planning work (scoring, analysis) happens off the realtime audio callback.
"""

from __future__ import annotations

import logging
import math
import threading
from pathlib import Path
from typing import Any, Callable, Optional

from madcool_dj_engine.analyze import analyze_file
from madcool_dj_engine.cache import load_analysis
from madcool_dj_engine.cue import pick_intro_cue_sec, tempo_match_rate

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
    RECENT_LIMIT = 20
    TEMPO_CLAMP = 0.03  # ±3% pitch for beatmatch

    def __init__(self, handler: Any, broadcast: Callable[[str, dict], None], horizon_sec: float = 45.0):
        self.handler = handler
        self.broadcast = broadcast
        self.horizon_sec = horizon_sec
        self.enabled = False
        self.recent: list[str] = []
        self.last_plan: Optional[dict] = None

        self._planned_for: Optional[str] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def enable(self) -> None:
        if self.enabled and self._thread is not None and self._thread.is_alive():
            return
        # Stop any prior planner before starting a new one (avoid double tick).
        self.disable()
        self.enabled = True
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="autopilot")
        self._thread.start()

    def disable(self) -> None:
        self.enabled = False
        self._stop.set()
        self.notify_override(clear_plan=True)
        t = self._thread
        if t is not None and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=2.0)
        self._thread = None

    def notify_override(self, *, clear_plan: bool = True) -> None:
        """Human/agent deck or mixer command — cancel pending crossfade ramp."""
        try:
            self.handler.mixer.cancel_crossfade_ramp()
        except Exception:  # noqa: BLE001
            pass
        if clear_plan:
            self._planned_for = None
            if self.last_plan is not None:
                self.broadcast("plan", {"cancelled": True, "previous": self.last_plan})
                self.last_plan = None

    def _loop(self) -> None:
        me = threading.current_thread()
        while not self._stop.is_set():
            if self._thread is not me:
                break
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
                {
                    "path": path,
                    "bpm": analysis.get("bpm"),
                    "bands": analysis.get("bands") or {},
                    "_analysis": analysis,
                }
            )

        picked = pick_next(current, candidates, recent=self.recent)
        if picked is None:
            return None
        return {
            **picked,
            "current_bpm": current.get("bpm"),
            "current_analysis": current_analysis,
        }

    # -- transition ---------------------------------------------------------

    def tick(self) -> None:
        """If enabled and the active deck's remaining time is under the
        horizon, plan once per playthrough: pick a candidate from the
        library index + analysis cache, load/start it on the opposite deck
        (tempo-matched, intro-cued), and kick off the crossfade ramp.
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
            self.broadcast(
                "plan",
                {
                    "from": active_name,
                    "to": opposite_name,
                    "path": None,
                    "remaining_sec": round(remaining, 2),
                    "reason": "no_candidate",
                },
            )
            return

        next_path = plan["path"]
        next_analysis = plan.get("_analysis") or self._analysis_for(Path(next_path)) or {}
        current_bpm = float(plan.get("current_bpm") or 0.0)
        next_bpm = float(plan.get("bpm") or 0.0)
        rate = tempo_match_rate(current_bpm, next_bpm, clamp=self.TEMPO_CLAMP)
        cue_sec = pick_intro_cue_sec(next_analysis)

        mixer = self.handler.mixer
        mixer.load(opposite_name, Path(next_path), start_sec=cue_sec)
        if hasattr(mixer, "set_rate"):
            mixer.set_rate(opposite_name, rate)
        mixer.play(opposite_name)

        self.recent.append(active_path)
        del self.recent[: -self.RECENT_LIMIT]

        target = 1.0 if opposite_name == "b" else 0.0
        # Snap to mid so the blend is audible immediately, then ease home.
        mixer.set_crossfade(0.5)
        mixer.ramp_crossfade(target, duration_sec=self.CROSSFADE_RAMP_SEC)

        payload = {
            "from": active_name,
            "to": opposite_name,
            "path": next_path,
            "bpm": next_bpm or None,
            "current_bpm": current_bpm or None,
            "rate": round(rate, 4),
            "cue_sec": round(cue_sec, 3),
            "remaining_sec": round(remaining, 2),
            "ramp_sec": self.CROSSFADE_RAMP_SEC,
        }
        self.last_plan = payload
        self.broadcast("plan", payload)
