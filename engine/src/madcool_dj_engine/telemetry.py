"""Off-callback live telemetry: push levels (+ light deck snapshot) to clients."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)


class Telemetry:
    """Daemon that fans out mixer peak levels over the protocol broadcast."""

    def __init__(
        self,
        handler: Any,
        broadcast: Callable[[str, dict], None],
        *,
        hz: float = 15.0,
    ):
        self.handler = handler
        self.broadcast = broadcast
        self.interval = 1.0 / max(1.0, hz)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="telemetry")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=1.0)
        self._thread = None

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001
                logger.exception("telemetry tick failed")
            self._stop.wait(self.interval)

    def tick(self) -> None:
        mixer = self.handler.mixer
        levels = getattr(mixer, "last_levels", None) or {
            "peak_l": 0.0,
            "peak_r": 0.0,
            "deck_a": 0.0,
            "deck_b": 0.0,
        }
        self.broadcast(
            "levels",
            {
                "peak_l": round(float(levels.get("peak_l", 0.0)), 4),
                "peak_r": round(float(levels.get("peak_r", 0.0)), 4),
                "deck_a": round(float(levels.get("deck_a", 0.0)), 4),
                "deck_b": round(float(levels.get("deck_b", 0.0)), 4),
                "crossfade": round(float(mixer.crossfade), 3),
            },
        )
