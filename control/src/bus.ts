/**
 * Command bus: routes every `cmd` from HTTP/WS/MCP callers to the right
 * backend. `roon.*` goes to `roon.ts` (a real Roon extension connection to
 * Simon); everything else goes to the engine.
 */

import { engineClient } from "./engineClient.js";
import {
  changeSettings as roonChangeSettings,
  changeVolume as roonChangeVolume,
  control as roonControl,
  listZones as roonListZones,
  mute as roonMute,
  seek as roonSeek,
  type ControlAction,
} from "./roon.js";
import { searchSources } from "./sources/index.js";

const CONTROL_ACTIONS: readonly ControlAction[] = ["play", "pause", "playpause", "stop", "next", "previous"];

function isControlAction(action: unknown): action is ControlAction {
  return typeof action === "string" && (CONTROL_ACTIONS as readonly string[]).includes(action);
}

function envAudioMode(): string {
  return (process.env.DJ_AUDIO_MODE || "shared").trim().toLowerCase();
}

async function resolveAudioMode(): Promise<string> {
  try {
    const st = (await engineClient.request("status", {})) as { audio?: { mode?: string } };
    const mode = st?.audio?.mode;
    if (mode === "shared" || mode === "exclusive") return mode;
  } catch {
    /* fall through */
  }
  return envAudioMode();
}

function requireZone(params: Record<string, unknown>): string {
  const zone = params.zone;
  if (typeof zone !== "string" || !zone) throw new Error("roon_missing_zone");
  return zone;
}

export async function execute(cmd: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (cmd === "roon.zones") {
    return { zones: await roonListZones() };
  }

  if (cmd === "roon.control") {
    const zone = requireZone(params);
    const action = params.action;
    if (!isControlAction(action)) {
      throw new Error(`roon_control_invalid_action: ${String(action)}`);
    }
    const mode = await resolveAudioMode();
    let dacReleasedForRoon = false;
    if ((action === "play" || action === "playpause") && mode === "exclusive") {
      try {
        await engineClient.request("device.release", {});
        dacReleasedForRoon = true;
      } catch {
        /* engine may be down — still try Roon */
      }
    }
    await roonControl(zone, action);
    return { ok: true, zone, action, dacReleasedForRoon, audioMode: mode };
  }

  if (cmd === "roon.seek") {
    const zone = requireZone(params);
    const how = params.how === "relative" ? "relative" : "absolute";
    const seconds = Number(params.seconds);
    if (!Number.isFinite(seconds)) throw new Error("roon_seek_missing_seconds");
    await roonSeek(zone, how, seconds);
    return { ok: true, zone, how, seconds };
  }

  if (cmd === "roon.volume") {
    const zone = requireZone(params);
    const how =
      params.how === "relative" || params.how === "relative_step" ? params.how : "absolute";
    const value = Number(params.value);
    if (!Number.isFinite(value)) throw new Error("roon_volume_missing_value");
    await roonChangeVolume(zone, how, value);
    return { ok: true, zone, how, value };
  }

  if (cmd === "roon.mute") {
    const zone = requireZone(params);
    const how = params.how === "unmute" ? "unmute" : "mute";
    await roonMute(zone, how);
    return { ok: true, zone, how };
  }

  if (cmd === "roon.settings") {
    const zone = requireZone(params);
    const settings: { shuffle?: boolean; autoRadio?: boolean; loop?: string } = {};
    if (typeof params.shuffle === "boolean") settings.shuffle = params.shuffle;
    if (typeof params.autoRadio === "boolean") settings.autoRadio = params.autoRadio;
    if (typeof params.loop === "string") settings.loop = params.loop;
    await roonChangeSettings(zone, settings);
    return { ok: true, zone, settings };
  }

  if (cmd.startsWith("roon.")) {
    throw new Error(`roon_unknown_command: ${cmd}`);
  }

  if (cmd === "sources.search") {
    const q = params.q;
    if (typeof q !== "string") {
      throw new Error("sources_search_missing_q");
    }
    return searchSources(q);
  }

  return engineClient.request(cmd, params);
}
