/**
 * `/v1/live` WebSocket: fans out every engine push event to connected
 * dashboard/MCP clients, plus a `hello` on connect and a 15s ping to keep
 * idle connections (and NAT/proxy timeouts) alive.
 */

import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import { bearerFromHeader, tokenMatches } from "./auth.js";
import type { EngineClient, EngineEvent } from "./engineClient.js";

const PING_INTERVAL_MS = 15_000;
const LIVE_PATH = "/v1/live";

export function attachWebSocket(server: HttpServer, engineClient: EngineClient): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  // Single multiplexer — avoids one EventEmitter listener per tab.
  const forwardAll = (evt: EngineEvent) => {
    const payload = JSON.stringify(evt);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  };
  engineClient.on("event", forwardAll);

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== LIVE_PATH) {
      socket.destroy();
      return;
    }
    if (!isAuthorized(req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    ws.send(JSON.stringify({ event: "hello" }));

    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const pingTimer = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_INTERVAL_MS);

    ws.on("close", () => {
      clearInterval(pingTimer);
      clients.delete(ws);
    });
  });

  return wss;
}

function isAuthorized(req: IncomingMessage, url: URL): boolean {
  const expected = (process.env.DJ_TOKEN || "").trim();
  if (!expected) return true;

  const fromHeader = bearerFromHeader(req.headers.authorization);
  if (tokenMatches(fromHeader)) return true;

  return tokenMatches(url.searchParams.get("token"));
}
