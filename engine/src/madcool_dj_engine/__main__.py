"""CLI entry point: `python -m madcool_dj_engine --sock $PATH [--play]`.

Starts the Unix-socket command protocol; with `--play`, also claims the
default audio sink and starts the realtime output stream pulling PCM from
the mixer. Runs until SIGINT/SIGTERM.
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import threading

from madcool_dj_engine.audio_out import claim_default_sink, start_stream, stop_stream
from madcool_dj_engine.commands import EngineCommandHandler
from madcool_dj_engine.protocol import EngineProtocolServer

logger = logging.getLogger("madcool_dj_engine")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="madcool_dj_engine")
    parser.add_argument("--sock", required=True, help="Unix socket path to listen on")
    parser.add_argument(
        "--play",
        action="store_true",
        help="Claim the default sink and start the realtime output stream",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    args = parse_args(argv)

    handler = EngineCommandHandler()
    server = EngineProtocolServer(args.sock, handler.dispatch)
    handler.broadcast = server.broadcast
    handler.telemetry.broadcast = server.broadcast
    server.start()
    handler.telemetry.start()
    logger.info("listening on %s", args.sock)

    if args.play:
        claim_default_sink()
        start_stream(handler.mixer.mix_block)
        logger.info("audio output stream started")

    stop_event = threading.Event()

    def _handle_signal(signum, _frame):  # noqa: ANN001
        logger.info("received signal %s, shutting down", signum)
        stop_event.set()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    try:
        while not stop_event.is_set():
            stop_event.wait(0.5)
    finally:
        handler.telemetry.stop()
        stop_stream()
        server.stop()


if __name__ == "__main__":
    sys.exit(main())
