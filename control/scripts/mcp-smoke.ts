/**
 * MCP smoke test: connects a real MCP `Client` to `createMcpServer()` over an
 * in-memory transport pair (no stdio, no subprocess) and runs `tools/list`.
 * Doesn't need `ENGINE_SOCK` — no tool is actually *called*, so the bus is
 * never touched.
 *
 * Run: npx tsx scripts/mcp-smoke.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/mcp.js";

async function main(): Promise<void> {
  const server = createMcpServer();
  const client = new Client({ name: "mcp-smoke", version: "0.1.0" });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();

  console.log(`registered ${names.length} tools:`);
  for (const name of names) console.log(`  - ${name}`);

  // No engine connected in this smoke test, so this exercises the error path:
  // the tool call should come back as `isError: true` with a bus error message,
  // not throw/crash the server.
  const statusResult = await client.callTool({ name: "dj_status", arguments: {} });
  console.log("\ndj_status call result (no engine connected, error path expected):");
  console.log(JSON.stringify(statusResult, null, 2));

  await client.close();
  await server.close();
}

main().catch((err) => {
  console.error("mcp-smoke failed:", err);
  process.exitCode = 1;
});
