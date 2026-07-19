import { basename, extname } from "node:path";

import { engineClient } from "../engineClient.js";
import type { ResolvedTrack, SearchHit, SourceConnector } from "./types.js";

export interface LibraryTrack {
  path: string;
  analysis?: {
    duration_sec?: number | null;
  };
}

export interface LibraryListResult {
  tracks: LibraryTrack[];
}

export type ListLibraryFn = () => Promise<LibraryListResult>;

function titleFromPath(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function matchesQuery(track: LibraryTrack, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const title = titleFromPath(track.path).toLowerCase();
  return track.path.toLowerCase().includes(needle) || title.includes(needle);
}

async function defaultListLibrary(): Promise<LibraryListResult> {
  const result = await engineClient.request("library.list", {});
  if (typeof result !== "object" || result === null || !Array.isArray((result as LibraryListResult).tracks)) {
    throw new Error("library_list_invalid_response");
  }
  return result as LibraryListResult;
}

export class LocalConnector implements SourceConnector {
  readonly id = "local" as const;

  constructor(private readonly listLibrary: ListLibraryFn = defaultListLibrary) {}

  async search(q: string): Promise<SearchHit[]> {
    const { tracks } = await this.listLibrary();
    return tracks.filter((track) => matchesQuery(track, q)).map((track) => ({
      id: track.path,
      title: titleFromPath(track.path),
      artist: "",
      source: "local" as const,
    }));
  }

  async resolve(id: string): Promise<ResolvedTrack> {
    const { tracks } = await this.listLibrary();
    const track = tracks.find((entry) => entry.path === id);
    const durationSec = track?.analysis?.duration_sec ?? undefined;
    return {
      id,
      title: titleFromPath(id),
      artist: "",
      ...(durationSec != null ? { durationSec } : {}),
    };
  }

  async getPlayable(id: string): Promise<{ kind: "file"; path: string }> {
    return { kind: "file", path: id };
  }
}
