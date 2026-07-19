/**
 * MiniMax Music Generation + Lyrics + Cover client.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { loadMinimaxApiKey, MINIMAX_API_BASE, type MusicModel } from "./config.js";

export interface AudioSetting {
  sample_rate?: 16000 | 24000 | 32000 | 44100;
  bitrate?: 32000 | 64000 | 128000 | 256000;
  format?: "mp3" | "wav" | "pcm";
}

export interface GenerateMusicParams {
  model?: MusicModel;
  prompt: string;
  lyrics?: string;
  lyrics_optimizer?: boolean;
  is_instrumental?: boolean;
  output_format?: "url" | "hex";
  audio_setting?: AudioSetting;
  /** Cover mode */
  audio_url?: string;
  audio_base64?: string;
  cover_feature_id?: string;
}

export interface MusicGenerateResult {
  ok: true;
  model: string;
  prompt: string;
  path: string;
  duration_ms: number | null;
  sample_rate: number | null;
  size: number | null;
  trace_id?: string;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${loadMinimaxApiKey()}`,
    "Content-Type": "application/json",
  };
}

async function postJson(path: string, body: unknown, timeoutMs = 300_000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${MINIMAX_API_BASE}${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`minimax_bad_json: http_${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

function assertOk(json: Record<string, unknown>, label: string): void {
  const br = (json.base_resp || {}) as { status_code?: number; status_msg?: string };
  const code = br.status_code ?? -1;
  if (code !== 0) {
    throw new Error(`minimax_${label}_failed:${code}:${br.status_msg || "unknown"}`);
  }
}

export async function generateLyrics(prompt: string, mode = "write_full_song"): Promise<{ lyrics: string; raw: unknown }> {
  const json = (await postJson("/v1/lyrics_generation", { mode, prompt }, 120_000)) as Record<string, unknown>;
  assertOk(json, "lyrics");
  // Response shape may nest lyrics in data
  const data = (json.data || json) as Record<string, unknown>;
  const lyrics =
    (typeof data.lyrics === "string" && data.lyrics) ||
    (typeof data.text === "string" && data.text) ||
    (typeof json.lyrics === "string" && json.lyrics) ||
    "";
  if (!lyrics) {
    // Some responses put content in `data.lyrics` variants
    const alt = JSON.stringify(json);
    throw new Error(`minimax_lyrics_empty:${alt.slice(0, 200)}`);
  }
  return { lyrics, raw: json };
}

export async function coverPreprocess(params: {
  model?: "music-cover" | "music-cover-free";
  audio_url?: string;
  audio_base64?: string;
}): Promise<{
  cover_feature_id: string;
  formatted_lyrics: string;
  audio_duration: number | null;
  structure_result: string | null;
}> {
  const json = (await postJson(
    "/v1/music_cover_preprocess",
    {
      model: params.model || "music-cover",
      ...(params.audio_url ? { audio_url: params.audio_url } : {}),
      ...(params.audio_base64 ? { audio_base64: params.audio_base64 } : {}),
    },
    180_000,
  )) as Record<string, unknown>;
  assertOk(json, "cover_preprocess");
  const id = String(json.cover_feature_id || (json.data as { cover_feature_id?: string } | undefined)?.cover_feature_id || "");
  if (!id) throw new Error("minimax_cover_feature_missing");
  return {
    cover_feature_id: id,
    formatted_lyrics: String(json.formatted_lyrics || ""),
    audio_duration: typeof json.audio_duration === "number" ? json.audio_duration : null,
    structure_result: typeof json.structure_result === "string" ? json.structure_result : null,
  };
}

function generatedDir(): string {
  const root = process.env.MUSIC_ROOT || join(homedir(), "Music");
  const dir = join(root, "dj-library", "generated");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "track";
}

async function downloadUrl(url: string, dest: string, timeoutMs = 120_000): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`minimax_download_failed:${res.status}`);
    const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    await pipeline(nodeStream, createWriteStream(dest));
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("minimax_download_timeout");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function hexToFile(hex: string, dest: string): void {
  const buf = Buffer.from(hex, "hex");
  writeFileSync(dest, buf);
}

export async function generateMusic(params: GenerateMusicParams): Promise<MusicGenerateResult> {
  const model = params.model || "music-3.0";
  const format = params.audio_setting?.format || "mp3";
  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt,
    output_format: params.output_format || "url",
    audio_setting: {
      sample_rate: params.audio_setting?.sample_rate ?? 44100,
      bitrate: params.audio_setting?.bitrate ?? 256000,
      format,
    },
  };

  if (model === "music-cover" || model === "music-cover-free") {
    if (params.cover_feature_id) body.cover_feature_id = params.cover_feature_id;
    else if (params.audio_base64) body.audio_base64 = params.audio_base64;
    else if (params.audio_url) body.audio_url = params.audio_url;
    else throw new Error("minimax_cover_needs_audio");
    if (params.lyrics) body.lyrics = params.lyrics;
  } else {
    if (params.is_instrumental) {
      body.is_instrumental = true;
    } else if (params.lyrics_optimizer && !params.lyrics) {
      body.lyrics_optimizer = true;
    } else if (params.lyrics) {
      body.lyrics = params.lyrics;
    } else {
      body.lyrics_optimizer = true;
    }
  }

  const json = (await postJson("/v1/music_generation", body, 360_000)) as Record<string, unknown>;
  assertOk(json, "generate");
  const data = (json.data || {}) as { status?: number; audio?: string };
  if (data.status !== 2 || !data.audio) {
    throw new Error(`minimax_incomplete:status_${data.status}`);
  }

  const extra = (json.extra_info || {}) as {
    music_duration?: number;
    music_sample_rate?: number;
    music_size?: number;
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `minimax-${slug(params.prompt.slice(0, 40))}-${stamp}.${format}`;
  const dest = join(generatedDir(), name);

  if (String(body.output_format) === "hex" || (!data.audio.startsWith("http") && /^[0-9a-fA-F]+$/.test(data.audio.slice(0, 32)))) {
    hexToFile(data.audio, dest);
  } else {
    await downloadUrl(data.audio, dest);
  }

  // Sidecar metadata for MadCool library
  writeFileSync(
    dest + ".json",
    JSON.stringify(
      {
        source: "minimax",
        model,
        prompt: params.prompt,
        lyrics: params.lyrics || null,
        instrumental: !!params.is_instrumental,
        generated_at: new Date().toISOString(),
        duration_ms: extra.music_duration ?? null,
        sample_rate: extra.music_sample_rate ?? null,
        size: extra.music_size ?? null,
        trace_id: json.trace_id ?? null,
      },
      null,
      2,
    ),
  );

  return {
    ok: true,
    model,
    prompt: params.prompt,
    path: dest,
    duration_ms: extra.music_duration ?? null,
    sample_rate: extra.music_sample_rate ?? null,
    size: extra.music_size ?? null,
    trace_id: typeof json.trace_id === "string" ? json.trace_id : undefined,
  };
}

export function fileToBase64(path: string, maxBytes = 45 * 1024 * 1024): string {
  const buf = readFileSync(path);
  if (buf.length > maxBytes) throw new Error("minimax_ref_too_large");
  return buf.toString("base64");
}
