/**
 * In-memory MiniMax generation jobs so the dashboard can poll without
 * holding a single HTTP request open for ~2 minutes.
 */

import { randomUUID } from "node:crypto";

import { generateMusic, type GenerateMusicParams, type MusicGenerateResult } from "./client.js";

export type JobStatus = "queued" | "running" | "done" | "error";

export interface MusicJob {
  id: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  error?: string;
  result?: MusicGenerateResult;
  prompt?: string;
  model?: string;
}

const jobs = new Map<string, MusicJob>();

function touch(job: MusicJob): void {
  job.updated_at = new Date().toISOString();
}

export function listMusicJobs(limit = 20): MusicJob[] {
  return [...jobs.values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export function getMusicJob(id: string): MusicJob | undefined {
  return jobs.get(id);
}

export function startMusicJob(params: GenerateMusicParams): MusicJob {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job: MusicJob = {
    id,
    status: "queued",
    created_at: now,
    updated_at: now,
    prompt: params.prompt,
    model: params.model || "music-3.0",
  };
  jobs.set(id, job);

  // Fire and forget
  void (async () => {
    job.status = "running";
    touch(job);
    try {
      const result = await generateMusic(params);
      job.result = result;
      job.status = "done";
      touch(job);
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      touch(job);
    }
  })();

  return job;
}
