/**
 * MCP entry point: speaks MCP over stdio (for Cursor / Claude Desktop /
 * anything that launches a local MCP server as a subprocess). Connects the
 * engine socket like `index.ts` does, but never starts the HTTP server or
 * WebSocket — this process's only I/O is stdin/stdout for MCP framing.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { engineClient } from "./engineClient.js";
import { createMcpServer } from "./mcp.js";

engineClient.on("connect", () => {
  console.error(`[mcp] engine connected (${engineClient.path})`);
});
engineClient.on("disconnect", () => {
  console.error("[mcp] engine disconnected, will reconnect");
});
engineClient.on("error", (err: Error) => {
  console.error(`[mcp] engine socket error: ${err.message}`);
});
engineClient.connect();

const server = createMcpServer();
const transport = new StdioServerTransport();

server.connect(transport).then(
  () => {
    console.error("[mcp] server connected on stdio");
  },
  (err: Error) => {
    console.error(`[mcp] failed to connect transport: ${err.message}`);
    process.exitCode = 1;
  },
);

function shutdown(): void {
  engineClient.close();
  void server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
