export class NotConfiguredError extends Error {
  constructor(source: string, hint: string) {
    super(`${source} not configured: ${hint}`);
    this.name = "NotConfiguredError";
  }
}

export interface SearchHit {
  id: string;
  title: string;
  artist: string;
  source: "local" | "spotify" | "tidal" | "roon";
}

export interface ResolvedTrack {
  id: string;
  title: string;
  artist: string;
  durationSec?: number;
}

export interface SourceConnector {
  id: "local" | "spotify" | "tidal" | "roon";
  search(q: string): Promise<SearchHit[]>;
  resolve(id: string): Promise<ResolvedTrack>;
  getPlayable(id: string): Promise<{ kind: "file"; path: string } | { kind: "unsupported" }>;
}
