/**
 * MCP tool surface over the shared command bus (`bus.ts`). Every tool here is
 * a thin wrapper around `execute(cmd, params)` — the same bus the HTTP routes
 * and WebSocket use — so MCP clients (Cursor, Claude Desktop, ...) get the
 * exact same behavior as the REST API. `dj_roon_*` hit the `roon.*` stub in
 * `bus.ts` until Task 11 wires up the real Roon client.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { execute } from "./bus.js";

const deckSchema = z.enum(["a", "b"]).describe("Deck identifier: 'a' or 'b'");

function ok(result: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result ?? null) }],
  };
}

function err(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
    isError: true,
  };
}

/** Runs `cmd` on the bus and shapes the outcome into a `CallToolResult`. */
async function run(cmd: string, params: Record<string, unknown> = {}): Promise<CallToolResult> {
  try {
    return ok(await execute(cmd, params));
  } catch (error) {
    return err(error);
  }
}

/** Builds the MCP server and registers every `dj_*` tool against the bus. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "madcool-dj", version: "0.1.0" });

  server.registerTool(
    "dj_status",
    { description: "Get engine status: decks, crossfade position, autopilot state." },
    async () => run("status"),
  );

  server.registerTool(
    "dj_deck_load",
    {
      description: "Load a track onto a deck.",
      inputSchema: {
        deck: deckSchema,
        path: z.string().min(1).describe("Absolute path to the audio file"),
        startSec: z.number().nonnegative().optional().describe("Start offset in seconds"),
      },
    },
    async (args) => run("deck.load", args),
  );

  server.registerTool(
    "dj_deck_play",
    {
      description: "Start playback on a deck.",
      inputSchema: { deck: deckSchema },
    },
    async (args) => run("deck.play", args),
  );

  server.registerTool(
    "dj_deck_pause",
    {
      description: "Pause playback on a deck.",
      inputSchema: { deck: deckSchema },
    },
    async (args) => run("deck.pause", args),
  );

  server.registerTool(
    "dj_mixer_crossfade",
    {
      description: "Set the crossfader position (0 = deck A, 1 = deck B).",
      inputSchema: { position: z.number().min(0).max(1) },
    },
    async (args) => run("mixer.crossfade", args),
  );

  server.registerTool(
    "dj_autopilot_enable",
    { description: "Enable autopilot (automatic track selection and mixing)." },
    async () => run("autopilot.enable"),
  );

  server.registerTool(
    "dj_autopilot_disable",
    { description: "Disable autopilot." },
    async () => run("autopilot.disable"),
  );

  server.registerTool(
    "dj_fx_set",
    {
      description: "Set FX/mixer parameters. Passes the `params` object straight through to the engine's fx.set command.",
      inputSchema: { params: z.record(z.string(), z.unknown()).describe("Arbitrary fx key/value pairs") },
    },
    async (args) => run("fx.set", args.params),
  );

  server.registerTool(
    "dj_library_scan",
    {
      description: "Scan a directory for playable tracks and rebuild the in-memory library index.",
      inputSchema: { root: z.string().min(1).optional().describe("Directory to scan; defaults to MUSIC_ROOT") },
    },
    async (args) => run("library.scan", args),
  );

  server.registerTool(
    "dj_library_list",
    { description: "List tracks in the current library index, with cached analysis if available." },
    async () => run("library.list"),
  );

  server.registerTool(
    "dj_analyze_file",
    {
      description: "Analyze a single audio file (BPM, duration, band energy), using the on-disk cache when possible.",
      inputSchema: { path: z.string().min(1).describe("Absolute path to the audio file") },
    },
    async (args) => run("analyze.file", args),
  );

  server.registerTool(
    "dj_device_claim",
    { description: "Best-effort claim of the default PipeWire sink for the engine's output." },
    async () => run("device.claim"),
  );

  server.registerTool(
    "dj_roon_zones",
    { description: "List Roon zones. Stubbed until Task 11 wires up the Roon client." },
    async () => run("roon.zones"),
  );

  server.registerTool(
    "dj_roon_control",
    {
      description: "Control a Roon zone (play/pause/etc). Stubbed until Task 11 wires up the Roon client.",
      inputSchema: {
        zone: z.string().min(1).describe("Roon zone id or name"),
        action: z.string().min(1).describe("Transport action, e.g. 'play', 'pause', 'next'"),
      },
    },
    async (args) => run("roon.control", args),
  );

  return server;
}
