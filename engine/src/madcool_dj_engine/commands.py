"""Command dispatch: routes protocol requests onto a `DualDeckMixer`, the
analyzer, the autopilot planner, and a simple in-memory library index.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable, Optional

from madcool_dj_engine import __version__
from madcool_dj_engine.analyze import analyze_file
from madcool_dj_engine.audio_out import (
    audio_info,
    claim_default_sink,
    has_callback,
    restart_stream,
    set_mode,
    stop_stream,
    stream_active,
)
from madcool_dj_engine.autopilot import Autopilot
from madcool_dj_engine.cache import load_analysis
from madcool_dj_engine.library import browse_dir, scan_dir
from madcool_dj_engine.mixer import DualDeckMixer

_REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_LIBRARY_ROOT = _REPO_ROOT / "fixtures" / "clips"


class CommandError(Exception):
    """Expected command failure (bad params, unsupported command, ...)."""


class EngineCommandHandler:
    def __init__(self, mixer: Optional[DualDeckMixer] = None, broadcast: Optional[Callable[[str, dict], None]] = None):
        self.mixer = mixer if mixer is not None else DualDeckMixer()
        self.broadcast = broadcast or (lambda event, data: None)
        self.fx_state: dict[str, Any] = {}
        self.library_index: list[dict[str, Any]] = []
        self.autopilot = Autopilot(self, self._emit)

        self._commands: dict[str, Callable[[dict], Any]] = {
            "status": self._status,
            "device.claim": self._device_claim,
            "device.release": self._device_release,
            "device.setMode": self._device_set_mode,
            "deck.load": self._deck_load,
            "deck.waveform": self._deck_waveform,
            "deck.play": self._deck_play,
            "deck.pause": self._deck_pause,
            "deck.seek": self._deck_seek,
            "deck.jog": self._deck_jog,
            "deck.cue": self._deck_cue,
            "deck.setCue": self._deck_set_cue,
            "deck.setRate": self._deck_set_rate,
            "deck.nudgeRate": self._deck_nudge_rate,
            "deck.setGain": self._deck_set_gain,
            "deck.setEq": self._deck_set_eq,
            "mixer.crossfade": self._mixer_crossfade,
            "analyze.file": self._analyze_file,
            "library.scan": self._library_scan,
            "library.list": self._library_list,
            "library.browse": self._library_browse,
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
        self.broadcast(event, data)

    def _deck_summary(self, name: str) -> dict:
        state = self.mixer.decks.get(name)
        if state is None:
            return {
                "path": None,
                "playing": False,
                "position_sec": 0.0,
                "duration_sec": 0.0,
                "cue_sec": 0.0,
                "rate": 1.0,
                "gain": 1.0,
                "eq": {"low": 1.0, "mid": 1.0, "high": 1.0},
                "source": "local",
                "title": None,
            }
        return {
            "path": str(state.path),
            "playing": state.playing,
            "position_sec": round(state.position / float(self.mixer.sr), 3),
            "duration_sec": round(len(state.audio) / float(self.mixer.sr), 3),
            "cue_sec": round(state.cue_frame / float(self.mixer.sr), 3),
            "rate": round(state.rate, 4),
            "gain": round(state.gain, 3),
            "eq": {"low": state.eq.low, "mid": state.eq.mid, "high": state.eq.high},
            "source": state.source,
            "title": state.title,
        }

    def _status(self, params: dict) -> dict:
        return {
            "engine": "madcool-dj-engine",
            "version": __version__,
            "crossfade": self.mixer.crossfade,
            "decks": {"a": self._deck_summary("a"), "b": self._deck_summary("b")},
            "autopilot": self.autopilot.enabled,
            "fx": dict(self.fx_state),
            "audio": audio_info(),
        }

    def _device_claim(self, params: dict) -> dict:
        claim_default_sink()
        try:
            restart_stream()
            active = True
        except Exception:
            # Stream may not have been started yet (--play never passed); claim still helps.
            active = stream_active()
        info = audio_info()
        info["claimed"] = True
        info["stream_active"] = active
        return info

    def _device_release(self, params: dict) -> dict:
        """Stop the mix stream.

        Needed in exclusive mode so RoonBridge can take ALSA on Tom - AES.
        In shared mode this is optional (PipeWire can mix); still allowed.
        """
        closed = stop_stream()
        info = audio_info()
        info["released"] = closed
        return info

    def _device_set_mode(self, params: dict) -> dict:
        mode = params.get("mode")
        if not isinstance(mode, str):
            raise CommandError("missing_mode")
        try:
            set_mode(mode)
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        # Reopen on the device appropriate for the new mode when a stream exists.
        if stream_active() or has_callback():
            try:
                restart_stream()
            except Exception:
                pass
        return audio_info()

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
        source = str(params.get("source") or "local")
        title = str(params.get("title") or "")
        bins = int(params.get("waveformBins") or 256)
        try:
            self.mixer.load(deck, Path(path), start_sec=start_sec, source=source, title=title)
        except Exception as exc:
            raise CommandError(f"deck_load_failed: {exc}") from exc
        summary = self._deck_summary(deck)
        # Instant overview from the loaded PCM (no re-decode).
        try:
            summary["waveform"] = self.mixer.waveform(deck, bins=bins)
        except Exception:
            summary["waveform"] = []
        cached = load_analysis(Path(path)) if Path(path).exists() else None
        if cached:
            summary["analysis"] = {
                "bpm": cached.get("bpm"),
                "duration_sec": cached.get("duration_sec"),
                "bands": cached.get("bands"),
                "energy": cached.get("energy"),
                "beats": cached.get("beats"),
            }
        else:
            summary["analysis"] = None
        return summary

    def _deck_waveform(self, params: dict) -> dict:
        deck = self._require_deck(params)
        bins = int(params.get("bins") or 256)
        try:
            energy = self.mixer.waveform(deck, bins=bins)
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        return {"deck": deck, "energy": energy, "bins": len(energy)}

    def _deck_play(self, params: dict) -> dict:
        deck = self._require_deck(params)
        try:
            self.mixer.play(deck)
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        return self._deck_summary(deck)

    def _deck_pause(self, params: dict) -> dict:
        deck = self._require_deck(params)
        self.mixer.pause(deck)
        return self._deck_summary(deck)

    def _deck_seek(self, params: dict) -> dict:
        deck = self._require_deck(params)
        if "positionSec" not in params:
            raise CommandError("missing_positionSec")
        try:
            self.mixer.seek(deck, float(params["positionSec"]))
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        return self._deck_summary(deck)

    def _deck_jog(self, params: dict) -> dict:
        deck = self._require_deck(params)
        if "deltaSec" not in params:
            raise CommandError("missing_deltaSec")
        try:
            self.mixer.jog(deck, float(params["deltaSec"]))
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        return self._deck_summary(deck)

    def _deck_cue(self, params: dict) -> dict:
        deck = self._require_deck(params)
        try:
            self.mixer.cue(deck)
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        return self._deck_summary(deck)

    def _deck_set_cue(self, params: dict) -> dict:
        deck = self._require_deck(params)
        pos = params.get("positionSec")
        try:
            self.mixer.set_cue(deck, float(pos) if pos is not None else None)
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        return self._deck_summary(deck)

    def _deck_set_rate(self, params: dict) -> dict:
        deck = self._require_deck(params)
        if "rate" not in params:
            raise CommandError("missing_rate")
        try:
            self.mixer.set_rate(deck, float(params["rate"]))
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        return self._deck_summary(deck)

    def _deck_nudge_rate(self, params: dict) -> dict:
        deck = self._require_deck(params)
        if "delta" not in params:
            raise CommandError("missing_delta")
        try:
            self.mixer.nudge_rate(deck, float(params["delta"]))
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        return self._deck_summary(deck)

    def _deck_set_gain(self, params: dict) -> dict:
        deck = self._require_deck(params)
        if "gain" not in params:
            raise CommandError("missing_gain")
        try:
            self.mixer.set_gain(deck, float(params["gain"]))
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        return self._deck_summary(deck)

    def _deck_set_eq(self, params: dict) -> dict:
        deck = self._require_deck(params)
        try:
            self.mixer.set_eq(
                deck,
                low=float(params["low"]) if "low" in params else None,
                mid=float(params["mid"]) if "mid" in params else None,
                high=float(params["high"]) if "high" in params else None,
            )
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        return self._deck_summary(deck)

    def _mixer_crossfade(self, params: dict) -> dict:
        position = params.get("position")
        if position is None:
            raise CommandError("missing_position")
        self.mixer.set_crossfade(float(position))
        return {"crossfade": self.mixer.crossfade}

    def _analyze_file(self, params: dict) -> dict:
        path = params.get("path")
        if not path:
            raise CommandError("missing_path")
        result = analyze_file(Path(path))
        return {
            "bpm": result.get("bpm"),
            "duration_sec": result.get("duration_sec"),
            "bands": result.get("bands"),
            "energy": result.get("energy"),
            "beats": result.get("beats"),
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
            item: dict[str, Any] = {"path": entry["path"], "title": path.stem}
            cached = load_analysis(path) if path.exists() else None
            if cached:
                item["analysis"] = {
                    "bpm": cached.get("bpm"),
                    "duration_sec": cached.get("duration_sec"),
                    "bands": cached.get("bands"),
                    "energy": cached.get("energy"),
                    "beats": cached.get("beats"),
                }
            tracks.append(item)
        return {"tracks": tracks}

    def _library_browse(self, params: dict) -> dict:
        raw = params.get("path") or os.environ.get("MUSIC_ROOT") or str(Path.home() / "Music")
        try:
            return browse_dir(Path(str(raw)))
        except FileNotFoundError as exc:
            raise CommandError(str(exc)) from exc
        except PermissionError as exc:
            raise CommandError(str(exc)) from exc
        except OSError as exc:
            raise CommandError(f"browse_failed: {exc}") from exc

    def _autopilot_enable(self, params: dict) -> dict:
        self.autopilot.enable()
        return {"autopilot": True}

    def _autopilot_disable(self, params: dict) -> dict:
        self.autopilot.disable()
        return {"autopilot": False}

    def _fx_set(self, params: dict) -> dict:
        self.fx_state.update(params)
        return {"fx": dict(self.fx_state)}
