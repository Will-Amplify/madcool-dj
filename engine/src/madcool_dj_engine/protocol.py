"""Unix-socket JSON-lines protocol server.

Each client connection speaks newline-delimited JSON: one request per line in,
one response per line out, plus event lines pushed asynchronously (levels,
log, decks, plan, engine.hello, ...). Kept deliberately simple for v1 — one
thread per connection, a single lock serializes calls into the command
dispatcher so mixer/library state stays consistent across concurrent clients.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

Dispatch = Callable[[str, dict], Any]


class EngineProtocolServer:
    """Binds a Unix socket, accepts clients, and dispatches JSON-line requests.

    `dispatch(cmd, params)` should return the `result` payload on success, or
    raise an exception (any `Exception`, including `commands.CommandError`)
    to produce an `{"ok": false, "error": ...}` response.
    """

    def __init__(self, sock_path: str | Path, dispatch: Dispatch, emit_hello: bool = True):
        self.sock_path = str(sock_path)
        self.dispatch = dispatch
        self.emit_hello = emit_hello
        self._server: socket.socket | None = None
        self._clients: list[tuple[socket.socket, threading.Lock]] = []
        self._clients_lock = threading.Lock()
        self._dispatch_lock = threading.Lock()
        self._stop = threading.Event()
        self._accept_thread: threading.Thread | None = None

    def start(self) -> None:
        """Bind and start accepting clients in a background thread."""
        sock_path = Path(self.sock_path)
        sock_path.parent.mkdir(parents=True, exist_ok=True)
        if sock_path.exists():
            sock_path.unlink()

        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(sock_path))
        try:
            os.chmod(str(sock_path), 0o600)
        except OSError:
            logger.warning("could not chmod socket to 0600: %s", sock_path)
        server.listen(8)
        self._server = server

        self._accept_thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._accept_thread.start()

    def stop(self) -> None:
        """Close the listening socket, disconnect clients, remove the sock file."""
        self._stop.set()
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
        with self._clients_lock:
            clients = list(self._clients)
        for conn, _lock in clients:
            try:
                conn.close()
            except OSError:
                pass
        sock_path = Path(self.sock_path)
        if sock_path.exists():
            try:
                sock_path.unlink()
            except OSError:
                pass

    def broadcast(self, event: str, data: dict) -> None:
        """Push `{"event": ..., "data": ...}` to every connected client."""
        line = json.dumps({"event": event, "data": data}) + "\n"
        with self._clients_lock:
            clients = list(self._clients)
        for conn, lock in clients:
            self._send_raw(conn, lock, line)

    def _accept_loop(self) -> None:
        assert self._server is not None
        while not self._stop.is_set():
            try:
                conn, _addr = self._server.accept()
            except OSError:
                break
            lock = threading.Lock()
            with self._clients_lock:
                self._clients.append((conn, lock))
            if self.emit_hello:
                self._send(conn, lock, {"event": "engine.hello", "data": {}})
            t = threading.Thread(target=self._client_loop, args=(conn, lock), daemon=True)
            t.start()

    def _client_loop(self, conn: socket.socket, lock: threading.Lock) -> None:
        try:
            with conn.makefile("rb") as reader:
                for raw_line in reader:
                    line = raw_line.strip()
                    if line:
                        self._handle_line(conn, lock, line)
        except OSError:
            pass
        finally:
            self._drop_client(conn)

    def _handle_line(self, conn: socket.socket, lock: threading.Lock, line: bytes) -> None:
        try:
            request = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send(conn, lock, {"id": None, "ok": False, "error": f"bad_json: {exc}"})
            return

        req_id = request.get("id") if isinstance(request, dict) else None
        cmd = request.get("cmd") if isinstance(request, dict) else None
        params = (request.get("params") if isinstance(request, dict) else None) or {}

        if not cmd:
            self._send(conn, lock, {"id": req_id, "ok": False, "error": "missing_cmd"})
            return

        try:
            with self._dispatch_lock:
                result = self.dispatch(cmd, params)
        except Exception as exc:  # noqa: BLE001 - a bad command must not kill the connection
            logger.warning("command %r failed: %s", cmd, exc)
            self._send(conn, lock, {"id": req_id, "ok": False, "error": str(exc)})
            return

        self._send(conn, lock, {"id": req_id, "ok": True, "result": result})

    def _send(self, conn: socket.socket, lock: threading.Lock, payload: dict) -> None:
        self._send_raw(conn, lock, json.dumps(payload) + "\n")

    def _send_raw(self, conn: socket.socket, lock: threading.Lock, line: str) -> None:
        try:
            with lock:
                conn.sendall(line.encode("utf-8"))
        except OSError:
            self._drop_client(conn)

    def _drop_client(self, conn: socket.socket) -> None:
        with self._clients_lock:
            self._clients = [(c, lock) for c, lock in self._clients if c is not conn]
        try:
            conn.close()
        except OSError:
            pass
