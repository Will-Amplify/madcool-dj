/**
 * `/v1/live` WebSocket: fans out every engine push event to connected
 * dashboard/MCP clients, plus a `hello` on connect and a 15s ping to keep
 * idle connections (and NAT/proxy timeouts) alive.
 */

import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import type { EngineClient, EngineEvent } from "./engineClient.js";

const PING_INTERVAL_MS = 15_000;
const LIVE_PATH = "/v1/live";

export function attachWebSocket(server: HttpServer, engineClient: EngineClient): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

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
    ws.send(JSON.stringify({ event: "hello" }));

    const forward = (evt: EngineEvent) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(evt));
    };
    engineClient.on("event", forward);

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
      engineClient.off("event", forward);
    });
  });

  return wss;
}

function isAuthorized(req: IncomingMessage, url: URL): boolean {
  const token = process.env.DJ_TOKEN;
  if (!token) return true;

  const header = req.headers.authorization ?? "";
  const [scheme, value] = header.split(" ");
  if (scheme === "Bearer" && value === token) return true;

  return url.searchParams.get("token") === token;
}
