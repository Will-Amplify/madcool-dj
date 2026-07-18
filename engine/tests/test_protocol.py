import json
import socket
import wave
from pathlib import Path

import numpy as np
import pytest

from madcool_dj_engine.commands import EngineCommandHandler
from madcool_dj_engine.protocol import EngineProtocolServer


def _fixture(name: str) -> Path:
    return Path(__file__).resolve().parents[2] / "fixtures" / "clips" / name


def _write_tiny_wav(path: Path, seconds: float = 0.25, sr: int = 44100) -> Path:
    """A short synthetic stereo WAV, decodable by ffmpeg without fixtures."""
    t = np.arange(int(sr * seconds)) / sr
    mono = (0.2 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)
    stereo = np.stack([mono, mono], axis=1)
    pcm16 = (stereo * 32767.0).astype(np.int16)

    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm16.tobytes())
    return path


def _clip_path(tmp_path: Path) -> Path:
    fixture = _fixture("clip_a.wav")
    if fixture.exists():
        return fixture
    return _write_tiny_wav(tmp_path / "synthetic.wav")


class _Client:
    """Minimal newline-delimited JSON client over a Unix socket."""

    def __init__(self, sock_path: str):
        self.conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.conn.connect(sock_path)
        self.reader = self.conn.makefile("rb")

    def recv_line(self) -> dict:
        raw = self.reader.readline()
        assert raw, "connection closed before a line was received"
        return json.loads(raw.decode("utf-8"))

    def request(self, req_id: str, cmd: str, params: dict | None = None) -> dict:
        payload = {"id": req_id, "cmd": cmd, "params": params or {}}
        self.conn.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        return self.recv_line()

    def close(self) -> None:
        try:
            self.reader.close()
        finally:
            self.conn.close()


@pytest.fixture
def server(tmp_path: Path):
    sock_path = tmp_path / "engine.sock"
    handler = EngineCommandHandler()
    srv = EngineProtocolServer(sock_path, handler.dispatch)
    srv.start()
    try:
        yield srv, sock_path, handler
    finally:
        srv.stop()


def test_status_roundtrip(server):
    srv, sock_path, _handler = server
    client = _Client(str(sock_path))
    try:
        hello = client.recv_line()
        assert hello["event"] == "engine.hello"

        resp = client.request("1", "status")
        assert resp["id"] == "1"
        assert resp["ok"] is True
        result = resp["result"]
        assert result["engine"] == "madcool-dj-engine"
        assert "version" in result
        assert result["autopilot"] is False
        assert set(result["decks"].keys()) == {"a", "b"}
        assert result["decks"]["a"]["playing"] is False
    finally:
        client.close()


def test_deck_load_play_reflected_in_status(server, tmp_path: Path):
    srv, sock_path, _handler = server
    clip = _clip_path(tmp_path)
    client = _Client(str(sock_path))
    try:
        client.recv_line()  # engine.hello

        load_resp = client.request("1", "deck.load", {"deck": "a", "path": str(clip)})
        assert load_resp["ok"] is True
        assert load_resp["result"]["path"] == str(clip)
        assert load_resp["result"]["playing"] is False

        play_resp = client.request("2", "deck.play", {"deck": "a"})
        assert play_resp["ok"] is True
        assert play_resp["result"]["playing"] is True

        status_resp = client.request("3", "status")
        assert status_resp["ok"] is True
        assert status_resp["result"]["decks"]["a"]["playing"] is True
    finally:
        client.close()


def test_roon_commands_handled_by_control(server):
    srv, sock_path, _handler = server
    client = _Client(str(sock_path))
    try:
        client.recv_line()  # engine.hello
        resp = client.request("1", "roon.zones")
        assert resp["ok"] is False
        assert resp["error"] == "handled_by_control"
    finally:
        client.close()


def test_unknown_command_is_an_error(server):
    srv, sock_path, _handler = server
    client = _Client(str(sock_path))
    try:
        client.recv_line()  # engine.hello
        resp = client.request("1", "nope.command")
        assert resp["ok"] is False
        assert "unknown_command" in resp["error"]
    finally:
        client.close()


def test_concurrent_clients_both_get_status(server):
    srv, sock_path, _handler = server
    client_a = _Client(str(sock_path))
    client_b = _Client(str(sock_path))
    try:
        client_a.recv_line()
        client_b.recv_line()

        resp_a = client_a.request("a1", "status")
        resp_b = client_b.request("b1", "status")
        assert resp_a["ok"] is True
        assert resp_b["ok"] is True
    finally:
        client_a.close()
        client_b.close()


def test_autopilot_enable_disable_flag(server):
    srv, sock_path, _handler = server
    client = _Client(str(sock_path))
    try:
        client.recv_line()

        enable_resp = client.request("1", "autopilot.enable")
        assert enable_resp["result"]["autopilot"] is True

        status_resp = client.request("2", "status")
        assert status_resp["result"]["autopilot"] is True

        disable_resp = client.request("3", "autopilot.disable")
        assert disable_resp["result"]["autopilot"] is False
    finally:
        client.close()


def test_library_scan_and_list(server, tmp_path: Path):
    srv, sock_path, _handler = server
    clip = _clip_path(tmp_path)
    client = _Client(str(sock_path))
    try:
        client.recv_line()

        scan_resp = client.request("1", "library.scan", {"root": str(clip.parent)})
        assert scan_resp["ok"] is True
        assert scan_resp["result"]["count"] >= 1

        list_resp = client.request("2", "library.list")
        assert list_resp["ok"] is True
        paths = [t["path"] for t in list_resp["result"]["tracks"]]
        assert str(clip.resolve()) in paths
    finally:
        client.close()
