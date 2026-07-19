/**
 * High-level music.* command handlers for the control bus.
 */

import { basename } from "node:path";

import { engineClient } from "../engineClient.js";
import { hasMinimaxKey } from "./config.js";
import { coverPreprocess, fileToBase64, generateLyrics } from "./client.js";
import { getMusicJob, listMusicJobs, startMusicJob } from "./jobs.js";
import {
  composeCoverPrompt,
  composeMusicPrompt,
  defaultLyricsScaffold,
  guessGenreFromAnalysis,
  parseFilenameMeta,
  type MusicGenSettings,
} from "./prompt.js";
import type { MusicModel } from "./config.js";

function asRecord(params: Record<string, unknown>): Record<string, unknown> {
  return params || {};
}

function settingsFromParams(params: Record<string, unknown>): MusicGenSettings {
  const ref = params.reference;
  return {
    bpm: typeof params.bpm === "number" ? params.bpm : params.bpm != null ? Number(params.bpm) : null,
    key: typeof params.key === "string" ? params.key : null,
    genre: typeof params.genre === "string" ? params.genre : null,
    subgenre: typeof params.subgenre === "string" ? params.subgenre : null,
    moods: Array.isArray(params.moods) ? params.moods.map(String) : [],
    complexity: (params.complexity as MusicGenSettings["complexity"]) || "balanced",
    energy: (params.energy as MusicGenSettings["energy"]) || "medium",
    vocals: (params.vocals as MusicGenSettings["vocals"]) || "none",
    vocalStyle: typeof params.vocalStyle === "string" ? params.vocalStyle : null,
    instruments: Array.isArray(params.instruments) ? params.instruments.map(String) : [],
    atmosphere: typeof params.atmosphere === "string" ? params.atmosphere : null,
    theme: typeof params.theme === "string" ? params.theme : null,
    avoid: typeof params.avoid === "string" ? params.avoid : null,
    useCase: typeof params.useCase === "string" ? params.useCase : null,
    era: typeof params.era === "string" ? params.era : null,
    extras: typeof params.extras === "string" ? params.extras : null,
    reference:
      ref && typeof ref === "object"
        ? (ref as MusicGenSettings["reference"])
        : null,
  };
}

export async function handleMusicCommand(cmd: string, params: Record<string, unknown>): Promise<unknown> {
  const p = asRecord(params);

  if (cmd === "music.status") {
    return { configured: hasMinimaxKey(), jobs: listMusicJobs(10) };
  }

  if (cmd === "music.previewPrompt") {
    const settings = settingsFromParams(p);
    const cover = p.mode === "cover";
    const prompt =
      typeof p.prompt === "string" && p.prompt.trim()
        ? p.prompt.trim()
        : cover
          ? composeCoverPrompt(settings)
          : composeMusicPrompt(settings);
    return { prompt, settings };
  }

  if (cmd === "music.analyzeRef") {
    const path = String(p.path || "");
    if (!path) throw new Error("music_ref_missing_path");
    const analysis = (await engineClient.request("analyze.file", { path })) as {
      bpm?: number;
      duration_sec?: number;
      bands?: Record<string, number>;
      title?: string;
      artist?: string;
    };
    const fileMeta = parseFilenameMeta(basename(path));
    const title = analysis.title || fileMeta.title || null;
    const artist = analysis.artist || fileMeta.artist || null;
    const bpm = analysis.bpm ?? null;
    const genre = guessGenreFromAnalysis(bpm, analysis.bands || null);
    const settings: MusicGenSettings = {
      bpm,
      genre,
      moods: ["inspired", "faithful-to-vibe"],
      complexity: "balanced",
      energy: bpm && bpm >= 130 ? "high" : "medium",
      vocals: "none",
      instruments: [],
      atmosphere: artist || title ? `channeling ${[artist, title].filter(Boolean).join(" — ")}` : null,
      theme: title ? `a spiritual cousin to “${title}”` : "signal cutting through noise",
      useCase: "DJ set / floor test",
      reference: {
        title,
        artist,
        genre,
        bpm,
        duration_sec: analysis.duration_sec ?? null,
        notes: "Match groove, energy, and arrangement density — not melodic plagiarism.",
      },
    };
    const prompt = composeMusicPrompt(settings);
    return {
      path,
      title,
      artist,
      bpm,
      duration_sec: analysis.duration_sec ?? null,
      genre,
      bands: analysis.bands ?? null,
      settings,
      prompt,
    };
  }

  if (cmd === "music.lyrics") {
    if (!hasMinimaxKey()) throw new Error("minimax_api_key_missing");
    const settings = settingsFromParams(p);
    const prompt =
      typeof p.prompt === "string" && p.prompt.trim()
        ? p.prompt.trim()
        : composeMusicPrompt({ ...settings, vocals: settings.vocals === "none" ? "male" : settings.vocals });
    try {
      const { lyrics } = await generateLyrics(prompt);
      return { lyrics, prompt, source: "minimax" };
    } catch {
      const scaffold = defaultLyricsScaffold(settings.theme || "midnight signal", (p.structure as "short" | "radio" | "full") || "radio");
      return { lyrics: scaffold, prompt, source: "scaffold" };
    }
  }

  if (cmd === "music.job") {
    const id = String(p.id || "");
    const job = getMusicJob(id);
    if (!job) throw new Error("music_job_not_found");
    return job;
  }

  if (cmd === "music.jobs") {
    return { jobs: listMusicJobs(Number(p.limit) || 20) };
  }

  if (cmd === "music.generate") {
    if (!hasMinimaxKey()) throw new Error("minimax_api_key_missing");
    const settings = settingsFromParams(p);
    const mode = String(p.mode || "generate"); // generate | cover
    const model = (typeof p.model === "string" ? p.model : mode === "cover" ? "music-cover" : "music-3.0") as MusicModel;
    const isInstrumental = p.is_instrumental === true || settings.vocals === "none";
    const prompt =
      typeof p.prompt === "string" && p.prompt.trim()
        ? p.prompt.trim()
        : mode === "cover"
          ? composeCoverPrompt(settings)
          : composeMusicPrompt(settings);

    if (mode === "cover") {
      const refPath = typeof p.ref_path === "string" ? p.ref_path : "";
      if (!refPath) throw new Error("music_cover_needs_ref_path");
      const audio_base64 = fileToBase64(refPath);
      // Optional two-step if lyrics provided
      let cover_feature_id: string | undefined;
      let lyrics = typeof p.lyrics === "string" ? p.lyrics : undefined;
      if (p.preprocess === true) {
        const pre = await coverPreprocess({
          model: model === "music-cover-free" ? "music-cover-free" : "music-cover",
          audio_base64,
        });
        cover_feature_id = pre.cover_feature_id;
        if (!lyrics && pre.formatted_lyrics) lyrics = pre.formatted_lyrics;
      }
      const job = startMusicJob({
        model,
        prompt,
        lyrics,
        audio_base64: cover_feature_id ? undefined : audio_base64,
        cover_feature_id,
        output_format: "url",
        audio_setting: {
          sample_rate: 44100,
          bitrate: 256000,
          format: (p.format as "mp3" | "wav") || "mp3",
        },
      });
      return job;
    }

    let lyrics = typeof p.lyrics === "string" ? p.lyrics : undefined;
    const lyricsOptimizer = p.lyrics_optimizer === true || (!isInstrumental && !lyrics);

    const job = startMusicJob({
      model,
      prompt,
      lyrics: isInstrumental ? undefined : lyrics,
      lyrics_optimizer: isInstrumental ? false : lyricsOptimizer,
      is_instrumental: isInstrumental,
      output_format: "url",
      audio_setting: {
        sample_rate: 44100,
        bitrate: (p.bitrate as 256000 | 128000) || 256000,
        format: (p.format as "mp3" | "wav") || "mp3",
      },
    });
    return job;
  }

  throw new Error(`music_unknown_command: ${cmd}`);
}
