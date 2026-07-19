export type DeckName = "a" | "b";

export interface DeckSummary {
  path: string | null;
  playing: boolean;
  position_sec: number;
  duration_sec?: number;
  cue_sec?: number;
  rate?: number;
  gain?: number;
  eq?: { low: number; mid: number; high: number };
  source?: string;
  title?: string | null;
}

export interface StatusResult {
  engine: string;
  version: string;
  crossfade: number;
  decks: { a: DeckSummary; b: DeckSummary };
  autopilot: boolean;
  fixtures_root?: string;
  plan?: PlanEvent | null;
  levels?: LevelsEvent;
  audio?: {
    mode?: string;
    stream_active?: boolean;
    device_name?: string | null;
    hostapi?: string | null;
  };
  studio?: {
    fx?: Record<string, unknown>;
    synth?: Record<string, unknown>;
    sampler?: { kit?: string | null; pads?: string[] };
    seq?: {
      playing?: boolean;
      bpm?: number;
      step_index?: number;
      patterns?: Record<string, number[]>;
      bass_notes?: number[];
    };
  };
}

export interface LevelsEvent {
  peak_l?: number;
  peak_r?: number;
  deck_a?: number;
  deck_b?: number;
  crossfade?: number;
}

export interface PlanEvent {
  from?: string;
  to?: string;
  path?: string | null;
  bpm?: number | null;
  current_bpm?: number | null;
  rate?: number;
  cue_sec?: number;
  remaining_sec?: number;
  ramp_sec?: number;
  reason?: string;
  cancelled?: boolean;
}

export interface TrackAnalysis {
  bpm?: number | null;
  duration_sec?: number | null;
  bands?: Record<string, number> | null;
  energy?: number[] | null;
  beats?: number[] | null;
}

export interface LibraryTrack {
  path: string;
  title?: string;
  analysis?: TrackAnalysis;
}

export interface LoadResult extends DeckSummary {
  waveform?: number[];
  analysis?: TrackAnalysis | null;
}

export interface BrowseDir {
  name: string;
  path: string;
}

export interface BrowseFile {
  name: string;
  path: string;
  title: string;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: BrowseDir[];
  files: BrowseFile[];
}

export interface RoonZone {
  zoneId: string;
  displayName: string;
  state: string;
  nowPlaying: { line1: string; line2: string; line3: string; length: number | null } | null;
  seekPosition: number | null;
  isPlayAllowed: boolean;
  isPauseAllowed: boolean;
  isPreviousAllowed: boolean;
  isNextAllowed: boolean;
  isSeekAllowed: boolean;
  queueItemsRemaining: number;
  settings: { loop: string; shuffle: boolean; autoRadio: boolean } | null;
  volume: {
    outputId: string;
    type: string;
    min: number | null;
    max: number | null;
    value: number | null;
    step: number | null;
    isMuted: boolean;
  } | null;
}

export interface CmdResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}
