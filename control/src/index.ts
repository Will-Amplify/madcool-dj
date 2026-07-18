/**
 * Boot the control plane: connect to the engine's Unix socket, start the
 * HTTP server (Hono over Node), and attach the `/v1/live` WebSocket.
 */

import type { Server } from "node:http";

import { serve } from "@hono/node-server";

import { engineClient } from "./engineClient.js";
import { createApp } from "./routes.js";
import { attachWebSocket } from "./ws.js";

const host = process.env.DJ_HOST || "127.0.0.1";
const port = Number(process.env.DJ_PORT || 8787);

engineClient.on("connect", () => {
  console.log(`[control] engine connected (${engineClient.path})`);
});
engineClient.on("disconnect", () => {
  console.warn("[control] engine disconnected, will reconnect");
});
engineClient.on("error", (err: Error) => {
  console.warn(`[control] engine socket error: ${err.message}`);
});
engineClient.connect();

const app = createApp();

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`[control] listening on http://${host}:${info.port}`);
});

attachWebSocket(server as unknown as Server, engineClient);

function shutdown(): void {
  console.log("[control] shutting down");
  engineClient.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
