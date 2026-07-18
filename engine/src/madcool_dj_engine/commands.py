"""Command dispatch: routes protocol requests onto a `DualDeckMixer`, the
analyzer, the autopilot planner, and a simple in-memory library index.

`fx.set` is still a noop store — real DSP wiring comes later, but the
command surface is stable so control/dashboard/MCP can be built against it
today.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable, Optional

from madcool_dj_engine import __version__
from madcool_dj_engine.analyze import analyze_file
from madcool_dj_engine.audio_out import claim_default_sink
from madcool_dj_engine.autopilot import Autopilot
from madcool_dj_engine.cache import load_analysis
from madcool_dj_engine.library import scan_dir
from madcool_dj_engine.mixer import DualDeckMixer

# engine/src/madcool_dj_engine/commands.py -> repo root
_REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_LIBRARY_ROOT = _REPO_ROOT / "fixtures" / "clips"


class CommandError(Exception):
    """Expected command failure (bad params, unsupported command, ...).

    Distinct from unexpected exceptions only for readability at call sites —
    the protocol server turns any raised exception into `{"ok": false}`.
    """


class EngineCommandHandler:
    """Holds engine-side state (mixer, library index, autopilot flag, fx) and
    dispatches named commands onto it.

    Not thread-safe on its own — `protocol.EngineProtocolServer` serializes
    calls to `dispatch` with a single lock, so one handler instance is safe
    to share across concurrent client connections.
    """

    def __init__(self, mixer: Optional[DualDeckMixer] = None, broadcast: Optional[Callable[[str, dict], None]] = None):
        self.mixer = mixer if mixer is not None else DualDeckMixer()
        self.broadcast = broadcast or (lambda event, data: None)
        self.fx_state: dict[str, Any] = {}
        self.library_index: list[dict[str, Any]] = []
        self.autopilot = Autopilot(self, self._emit)

        self._commands: dict[str, Callable[[dict], Any]] = {
            "status": self._status,
            "device.claim": self._device_claim,
            "deck.load": self._deck_load,
            "deck.play": self._deck_play,
            "deck.pause": self._deck_pause,
            "mixer.crossfade": self._mixer_crossfade,
            "analyze.file": self._analyze_file,
            "library.scan": self._library_scan,
            "library.list": self._library_list,
            "autopilot.enable": self._autopilot_enable,
            "autopilot.disable": self._autopilot_disable,
            "fx.set": self._fx_set,
        }

    def dispatch(self, cmd: str, params: dict) -> Any:
        if cmd.startswith("roon."):
            raise CommandError("handled_by_control")
        handler = self._commands.get(cmd)
        if handler is None:
            raise CommandError(f"unknown_command: {cmd}")
        return handler(params or {})

    def _emit(self, event: str, data: dict) -> None:
        """Autopilot's broadcast callback — indirects through `self.broadcast`
        so it stays current even if the protocol server is wired up after
        this handler (and its `Autopilot`) is constructed."""
        self.broadcast(event, data)

    # -- status ---------------------------------------------------------

    def _deck_summary(self, name: str) -> dict:
        state = self.mixer.decks.get(name)
        if state is None:
            return {"path": None, "playing": False, "position_sec": 0.0}
        return {
            "path": str(state.path),
            "playing": state.playing,
            "position_sec": round(state.position / float(self.mixer.sr), 3),
        }

    def _status(self, params: dict) -> dict:
        return {
            "engine": "madcool-dj-engine",
            "version": __version__,
            "crossfade": self.mixer.crossfade,
            "decks": {"a": self._deck_summary("a"), "b": self._deck_summary("b")},
            "autopilot": self.autopilot.enabled,
        }

    # -- device -----------------------------------------------------------

    def _device_claim(self, params: dict) -> dict:
        claim_default_sink()
        return {"claimed": True}

    # -- deck / mixer transport -----------------------------------------

    @staticmethod
    def _require_deck(params: dict) -> str:
        deck = params.get("deck")
        if deck not in ("a", "b"):
            raise CommandError(f"invalid deck: {deck!r} (expected 'a' or 'b')")
        return deck

    def _deck_load(self, params: dict) -> dict:
        deck = self._require_deck(params)
        path = params.get("path")
        if not path:
            raise CommandError("missing_path")
        start_sec = float(params.get("startSec") or 0.0)
        self.mixer.load(deck, Path(path), start_sec=start_sec)
        return self._deck_summary(deck)

    def _deck_play(self, params: dict) -> dict:
        deck = self._require_deck(params)
        self.mixer.play(deck)
        return self._deck_summary(deck)

    def _deck_pause(self, params: dict) -> dict:
        deck = self._require_deck(params)
        self.mixer.pause(deck)
        return self._deck_summary(deck)

    def _mixer_crossfade(self, params: dict) -> dict:
        position = params.get("position")
        if position is None:
            raise CommandError("missing_position")
        self.mixer.set_crossfade(float(position))
        return {"crossfade": self.mixer.crossfade}

    # -- analysis / library -----------------------------------------------

    def _analyze_file(self, params: dict) -> dict:
        path = params.get("path")
        if not path:
            raise CommandError("missing_path")
        result = analyze_file(Path(path))
        return {
            "bpm": result.get("bpm"),
            "duration_sec": result.get("duration_sec"),
            "bands": result.get("bands"),
        }

    def _library_scan(self, params: dict) -> dict:
        root = params.get("root") or os.environ.get("MUSIC_ROOT") or DEFAULT_LIBRARY_ROOT
        root_path = Path(root)

        self.library_index = [{"path": p} for p in scan_dir(root_path)]
        return {"root": str(root_path), "count": len(self.library_index)}

    def _library_list(self, params: dict) -> dict:
        tracks = []
        for entry in self.library_index:
            path = Path(entry["path"])
            item: dict[str, Any] = {"path": entry["path"]}
            cached = load_analysis(path) if path.exists() else None
            if cached:
                item["analysis"] = {
                    "bpm": cached.get("bpm"),
                    "duration_sec": cached.get("duration_sec"),
                    "bands": cached.get("bands"),
                }
            tracks.append(item)
        return {"tracks": tracks}

    # -- autopilot / fx -----------------------------------------------------

    def _autopilot_enable(self, params: dict) -> dict:
        self.autopilot.enable()
        return {"autopilot": True}

    def _autopilot_disable(self, params: dict) -> dict:
        self.autopilot.disable()
        return {"autopilot": False}

    def _fx_set(self, params: dict) -> dict:
        self.fx_state.update(params)
        return {"fx": dict(self.fx_state)}
