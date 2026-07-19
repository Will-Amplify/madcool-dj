/**
 * Command bus: routes every `cmd` from HTTP/WS/MCP callers to the right
 * backend. `roon.*` goes to `roon.ts` (a real Roon extension connection to
 * Simon); everything else goes to the engine.
 */

import { engineClient } from "./engineClient.js";
import { control as roonControl, listZones as roonListZones, type ControlAction } from "./roon.js";

const CONTROL_ACTIONS: readonly ControlAction[] = ["play", "pause", "playpause", "stop", "next", "previous"];

function isControlAction(action: unknown): action is ControlAction {
  return typeof action === "string" && (CONTROL_ACTIONS as readonly string[]).includes(action);
}

export async function execute(cmd: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (cmd === "roon.zones") {
    return { zones: await roonListZones() };
  }

  if (cmd === "roon.control") {
    const zone = params.zone;
    const action = params.action;
    if (typeof zone !== "string" || !zone) {
      throw new Error("roon_control_missing_zone");
    }
    if (!isControlAction(action)) {
      throw new Error(`roon_control_invalid_action: ${String(action)}`);
    }
    await roonControl(zone, action);
    return { ok: true, zone, action };
  }

  if (cmd.startsWith("roon.")) {
    throw new Error(`roon_unknown_command: ${cmd}`);
  }

  return engineClient.request(cmd, params);
}
