/**
 * MCP tool surface over the shared command bus (`bus.ts`). Every tool here is
 * a thin wrapper around `execute(cmd, params)` — the same bus the HTTP routes
 * and WebSocket use — so MCP clients (Cursor, Claude Desktop, ...) get the
 * exact same behavior as the REST API. `dj_roon_*` route to `roon.ts`, which
 * talks to a real Roon Core (Simon) over the network.
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
    "dj_deck_seek",
    {
      description: "Seek a deck to an absolute position in seconds.",
      inputSchema: {
        deck: deckSchema,
        positionSec: z.number().nonnegative(),
      },
    },
    async (args) => run("deck.seek", args),
  );

  server.registerTool(
    "dj_deck_jog",
    {
      description: "Nudge / scrub a deck by a relative delta in seconds (jog wheel).",
      inputSchema: {
        deck: deckSchema,
        deltaSec: z.number(),
      },
    },
    async (args) => run("deck.jog", args),
  );

  server.registerTool(
    "dj_deck_cue",
    {
      description: "Jump to the deck cue point and pause (back-cue).",
      inputSchema: { deck: deckSchema },
    },
    async (args) => run("deck.cue", args),
  );

  server.registerTool(
    "dj_deck_set_cue",
    {
      description: "Set the deck cue point to the current position (or an absolute positionSec).",
      inputSchema: {
        deck: deckSchema,
        positionSec: z.number().nonnegative().optional(),
      },
    },
    async (args) => run("deck.setCue", args),
  );

  server.registerTool(
    "dj_deck_set_rate",
    {
      description: "Set playback rate (0.92–1.08). Sample skip/hold — no heavy timestretch.",
      inputSchema: {
        deck: deckSchema,
        rate: z.number().min(0.92).max(1.08),
      },
    },
    async (args) => run("deck.setRate", args),
  );

  server.registerTool(
    "dj_deck_set_eq",
    {
      description: "Set deck EQ gains (linear; 1.0 = flat).",
      inputSchema: {
        deck: deckSchema,
        low: z.number().min(0).max(2).optional(),
        mid: z.number().min(0).max(2).optional(),
        high: z.number().min(0).max(2).optional(),
      },
    },
    async (args) => run("deck.setEq", args),
  );

  server.registerTool(
    "dj_deck_set_gain",
    {
      description: "Set deck channel gain (0–2).",
      inputSchema: {
        deck: deckSchema,
        gain: z.number().min(0).max(2),
      },
    },
    async (args) => run("deck.setGain", args),
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
    {
      description:
        "List Roon zones on Simon's Roon Core. Fails with a pending-authorization error until the 'MadCool DJ' extension is approved in Roon (Settings -> Extensions).",
    },
    async () => run("roon.zones"),
  );

  server.registerTool(
    "dj_roon_control",
    {
      description: "Control a Roon zone (play/pause/etc) on Simon's Roon Core.",
      inputSchema: {
        zone: z.string().min(1).describe("Roon zone id or name"),
        action: z.enum(["play", "pause", "playpause", "stop", "next", "previous"]).describe("Transport action"),
      },
    },
    async (args) => run("roon.control", args),
  );

  server.registerTool(
    "dj_sources_search",
    {
      description: "Search local library (+ stub Spotify/Tidal). Roon zones are separate via dj_roon_zones.",
      inputSchema: { q: z.string().describe("Search query") },
    },
    async (args) => run("sources.search", args),
  );

  return server;
}
