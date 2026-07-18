/**
 * Command bus: routes every `cmd` from HTTP/WS/MCP callers to the right
 * backend. Everything goes to the engine today; `roon.*` is stubbed out
 * until Task 11 wires up the Roon client.
 */

import { engineClient } from "./engineClient.js";

export async function execute(cmd: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (cmd.startsWith("roon.")) {
    return { ok: false, error: "roon_not_wired_yet" }; // Task 11
  }
  return engineClient.request(cmd, params);
}
