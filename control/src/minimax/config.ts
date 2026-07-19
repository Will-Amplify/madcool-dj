/**
 * MiniMax Music API config. Key from MINIMAX_API_KEY or ~/MiniMax API.txt.
 * Never log the key value.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MINIMAX_API_BASE = (process.env.MINIMAX_API_BASE || "https://api.minimax.io").replace(/\/$/, "");

export type MusicModel =
  | "music-3.0"
  | "music-3.0-free"
  | "music-2.6"
  | "music-2.6-free"
  | "music-cover"
  | "music-cover-free";

export function loadMinimaxApiKey(): string {
  const fromEnv = (process.env.MINIMAX_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const candidates = [
    process.env.MINIMAX_API_KEY_FILE,
    join(homedir(), "MiniMax API.txt"),
    join(homedir(), "MiniMax_API.txt"),
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8").trim().replace(/\s+/g, "");
    if (raw) return raw;
  }
  throw new Error("minimax_api_key_missing");
}

export function hasMinimaxKey(): boolean {
  try {
    loadMinimaxApiKey();
    return true;
  } catch {
    return false;
  }
}
