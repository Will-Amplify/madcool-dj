import "./style.css";

type DeckName = "a" | "b";

interface DeckSummary {
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

interface StatusResult {
  engine: string;
  version: string;
  crossfade: number;
  decks: { a: DeckSummary; b: DeckSummary };
  autopilot: boolean;
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

interface TrackAnalysis {
  bpm?: number | null;
  duration_sec?: number | null;
  bands?: Record<string, number> | null;
  energy?: number[] | null;
  beats?: number[] | null;
}

interface LibraryTrack {
  path: string;
  title?: string;
  analysis?: TrackAnalysis;
}

interface LoadResult extends DeckSummary {
  waveform?: number[];
  analysis?: TrackAnalysis | null;
}

interface BrowseDir {
  name: string;
  path: string;
}

interface BrowseFile {
  name: string;
  path: string;
  title: string;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: BrowseDir[];
  files: BrowseFile[];
}

interface RoonZone {
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

interface CmdResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

const BAND_KEYS = ["sub", "bass", "low_mid", "high_mid", "hats"] as const;
const TOKEN_KEY = "madcool-dj.token";
const LOAD_DECK_KEY = "madcool-dj.loadDeck";
const BROWSE_PATH_KEY = "madcool-dj.browsePath";
const MUSIC_ROOT = "/home/madcoolseed/Music";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const tokenInput = byId<HTMLInputElement>("token-input");
const connBadge = byId<HTMLDivElement>("conn-badge");
const roonBadge = byId<HTMLDivElement>("roon-badge");
const transportStatus = byId<HTMLSpanElement>("transport-status");
const libList = byId<HTMLUListElement>("lib-list");
const libSearch = byId<HTMLInputElement>("lib-search");
const browsePathEl = byId<HTMLDivElement>("browse-path");
const roonList = byId<HTMLUListElement>("roon-list");
const roonHint = byId<HTMLParagraphElement>("roon-hint");
const planBody = byId<HTMLDivElement>("plan-body");
const logBody = byId<HTMLDivElement>("log-body");
const crossfader = byId<HTMLInputElement>("crossfader");
const crossfaderValue = byId<HTMLDivElement>("crossfader-value");
const autopilotState = byId<HTMLSpanElement>("autopilot-state");
const engineVersion = byId<HTMLSpanElement>("engine-version");
const btnAutopilot = byId<HTMLButtonElement>("btn-autopilot");
const btnClaim = byId<HTMLButtonElement>("btn-claim");
const btnRelease = byId<HTMLButtonElement>("btn-release");
const btnAudioMode = byId<HTMLButtonElement>("btn-audio-mode");
const btnLoadFixtures = byId<HTMLButtonElement>("btn-load-fixtures");
const btnFind = byId<HTMLButtonElement>("btn-find");
const btnScan = byId<HTMLButtonElement>("btn-scan");
const btnBrowseUp = byId<HTMLButtonElement>("btn-browse-up");
const btnRoonRefresh = byId<HTMLButtonElement>("btn-roon-refresh");

let library: LibraryTrack[] = [];
let browseDirs: BrowseDir[] = [];
let browseFiles: BrowseFile[] = [];
let browsePath = localStorage.getItem(BROWSE_PATH_KEY) || MUSIC_ROOT;
let browseParent: string | null = null;
let analysisByPath = new Map<string, TrackAnalysis | undefined>();
let waveformByPath = new Map<string, number[]>();
let loadTarget: DeckName = (localStorage.getItem(LOAD_DECK_KEY) as DeckName) || "a";
let scrubbing: Record<DeckName, boolean> = { a: false, b: false };
let lastStatus: StatusResult | null = null;
let audioMode = "shared";
let jogAngle: Record<DeckName, number> = { a: 0, b: 0 };
const roonScrubbing = new Set<string>();
const roonVolChanging = new Set<string>();

function musicRoot(): string {
  return localStorage.getItem("madcool-dj.musicRoot") || MUSIC_ROOT;
}

function token(): string {
  return tokenInput.value.trim();
}

function authHeaders(): HeadersInit {
  const t = token();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function apiBase(): string {
  return "";
}

async function cmd<T = unknown>(command: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${apiBase()}/v1/cmd`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ cmd: command, params }),
  });
  const body = (await res.json()) as CmdResponse<T>;
  if (!body.ok) throw new Error(body.error || `cmd_failed:${command}`);
  return body.result as T;
}

async function getStatus(): Promise<StatusResult> {
  const res = await fetch(`${apiBase()}/v1/status`, { headers: { ...authHeaders() } });
  const body = (await res.json()) as CmdResponse<StatusResult>;
  if (!body.ok || !body.result) throw new Error(body.error || "status_failed");
  return body.result;
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function log(line: string): void {
  const ts = new Date().toLocaleTimeString();
  logBody.textContent = `[${ts}] ${line}\n` + (logBody.textContent || "");
  const lines = (logBody.textContent || "").split("\n");
  if (lines.length > 200) logBody.textContent = lines.slice(0, 200).join("\n");
}

function setBadge(el: HTMLElement, on: boolean, warn = false): void {
  el.classList.toggle("badge--on", on && !warn);
  el.classList.toggle("badge--warn", warn);
  el.classList.toggle("badge--off", !on && !warn);
}

function flash(msg: string): void {
  transportStatus.textContent = msg;
}

function drawWave(
  deck: DeckName,
  energy: number[] | null | undefined,
  beats: number[] | null | undefined,
  pos: number,
  dur: number,
): void {
  const canvas = byId<HTMLCanvasElement>(`deck-${deck}-canvas`);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#050807";
  ctx.fillRect(0, 0, w, h);
  const color = deck === "a" ? "#2fd8c4" : "#5ab0e8";
  const samples = energy && energy.length > 4 ? energy : null;
  if (!samples) {
    ctx.strokeStyle = "#1a2a26";
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  } else {
    const n = samples.length;
    const barW = w / n;
    for (let i = 0; i < n; i++) {
      const v = Math.max(0.02, Math.min(1, samples[i] ?? 0));
      const bh = v * (h - 4);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.55 + 0.45 * v;
      ctx.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
    }
    ctx.globalAlpha = 1;
  }
  if (beats && beats.length && dur > 0) {
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    for (const b of beats) {
      if (b < 0 || b > dur) continue;
      const x = (b / dur) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }
  const playhead = byId<HTMLDivElement>(`deck-${deck}-playhead`);
  const pct = dur > 0 ? Math.min(1, pos / dur) : 0;
  playhead.style.left = `${pct * 100}%`;
}

async function loadOntoDeck(deck: DeckName, path: string, title?: string): Promise<void> {
  const result = await cmd<LoadResult>("deck.load", {
    deck,
    path,
    source: "local",
    title: title || path.split("/").pop() || path,
  });
  if (result.waveform?.length) {
    waveformByPath.set(path, result.waveform);
  }
  if (result.analysis) {
    analysisByPath.set(path, {
      ...result.analysis,
      energy: result.waveform?.length ? result.waveform : result.analysis.energy,
    });
  } else if (result.waveform?.length) {
    analysisByPath.set(path, { energy: result.waveform });
  }
  if (!result.analysis?.bpm) {
    void cmd<TrackAnalysis>("analyze.file", { path })
      .then((a) => {
        const prev = analysisByPath.get(path) || {};
        analysisByPath.set(path, {
          ...prev,
          ...a,
          energy: waveformByPath.get(path) || a.energy || prev.energy,
        });
      })
      .catch(() => undefined);
  }
}

async function uploadOntoDeck(deck: DeckName, file: File): Promise<void> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("deck", deck);
  const res = await fetch(`${apiBase()}/v1/upload`, {
    method: "POST",
    headers: { ...authHeaders() },
    body: fd,
  });
  const body = (await res.json()) as CmdResponse<{ path: string; name: string; load: LoadResult | null }>;
  if (!body.ok || !body.result) throw new Error(body.error || "upload_failed");
  const { path, load } = body.result;
  if (load?.waveform?.length) waveformByPath.set(path, load.waveform);
  if (load?.analysis) {
    analysisByPath.set(path, {
      ...load.analysis,
      energy: load.waveform?.length ? load.waveform : load.analysis.energy,
    });
  } else if (load?.waveform?.length) {
    analysisByPath.set(path, { energy: load.waveform });
  }
  flash(`Dropped → ${deck.toUpperCase()}: ${file.name}`);
  log(`upload ${deck}: ${file.name}`);
}

function renderBands(deck: DeckName, bands: Record<string, number> | null | undefined): void {
  const el = byId<HTMLDivElement>(`deck-${deck}-bands`);
  el.innerHTML = "";
  for (const key of BAND_KEYS) {
    const bar = document.createElement("div");
    bar.className = "band";
    const v = bands?.[key] ?? 0;
    bar.style.height = `${Math.round(Math.max(0.05, Math.min(1, v)) * 100)}%`;
    bar.title = key;
    el.appendChild(bar);
  }
}

function updateDeckUi(deck: DeckName, d: DeckSummary): void {
  const stateEl = byId<HTMLSpanElement>(`deck-${deck}-state`);
  const playBtn = byId<HTMLButtonElement>(`deck-${deck}-play`);

  stateEl.textContent = d.path ? (d.playing ? "playing" : "paused") : "idle";
  stateEl.classList.toggle("is-playing", Boolean(d.playing));
  playBtn.textContent = d.playing ? "❚❚" : "▶";
  playBtn.classList.toggle("is-playing", Boolean(d.playing));
  byId<HTMLParagraphElement>(`deck-${deck}-title`).textContent = d.title || (d.path ? d.path.split("/").pop()! : "no track");
  byId<HTMLParagraphElement>(`deck-${deck}-path`).textContent = d.path || "";
  byId<HTMLSpanElement>(`deck-${deck}-pos`).textContent = fmt(d.position_sec);
  byId<HTMLSpanElement>(`deck-${deck}-dur`).textContent = fmt(d.duration_sec || 0);
  byId<HTMLSpanElement>(`deck-${deck}-cuepos`).textContent = fmt(d.cue_sec || 0);
  const rate = d.rate ?? 1;
  const pct = ((rate - 1) * 100).toFixed(1);
  byId<HTMLSpanElement>(`deck-${deck}-rate-val`).textContent = `${Number(pct) >= 0 ? "+" : ""}${pct}%`;
  if (!scrubbing[deck]) {
    const scrub = byId<HTMLInputElement>(`deck-${deck}-scrub`);
    const dur = d.duration_sec || 0;
    scrub.value = String(dur > 0 ? Math.round((d.position_sec / dur) * 1000) : 0);
  }
  const analysis = d.path ? analysisByPath.get(d.path) : undefined;
  const energy = (d.path && waveformByPath.get(d.path)) || analysis?.energy || null;
  byId<HTMLSpanElement>(`deck-${deck}-bpm`).textContent = analysis?.bpm ? analysis.bpm.toFixed(1) : "—";
  renderBands(deck, analysis?.bands ?? null);
  drawWave(deck, energy, analysis?.beats ?? null, d.position_sec, d.duration_sec || 0);
}

function matchesFilter(text: string, q: string): boolean {
  return text.toLowerCase().includes(q);
}

function wireFileRow(li: HTMLLIElement, path: string, label: string, title?: string): void {
  const indexed = library.find((t) => t.path === path);
  const bpm = indexed?.analysis?.bpm ? `${indexed.analysis.bpm.toFixed(0)} bpm` : "";
  li.draggable = true;
  li.innerHTML = `<span>${label}</span><span class="meta">${bpm}</span>`;
  li.title = `Load to deck ${loadTarget.toUpperCase()}: ${path}`;
  li.ondragstart = (ev) => {
    ev.dataTransfer?.setData("application/x-madcool-path", path);
    ev.dataTransfer?.setData("text/plain", path);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
  };
  li.onclick = async () => {
    try {
      await loadOntoDeck(loadTarget, path, title || label);
      log(`load ${loadTarget}: ${label}`);
      flash(`Loaded → ${loadTarget.toUpperCase()}`);
    } catch (e) {
      flash(String(e));
    }
  };
  li.oncontextmenu = (ev) => {
    ev.preventDefault();
    if (ev.shiftKey) {
      void useReferencePath(path).catch((e) => flash(String(e)));
      return;
    }
    loadTarget = loadTarget === "a" ? "b" : "a";
    localStorage.setItem(LOAD_DECK_KEY, loadTarget);
    flash(`Load target: deck ${loadTarget.toUpperCase()} · Shift+right-click = Music Gen ref`);
  };
}

function renderLibrary(): void {
  const q = libSearch.value.trim().toLowerCase();
  libList.innerHTML = "";

  for (const dir of browseDirs) {
    if (q && !matchesFilter(dir.name, q) && !matchesFilter(dir.path, q)) continue;
    const li = document.createElement("li");
    li.className = "is-dir";
    li.innerHTML = `<span>📁 ${dir.name}</span><span class="meta">dir</span>`;
    li.title = dir.path;
    li.onclick = () => void browseTo(dir.path);
    libList.appendChild(li);
  }

  for (const file of browseFiles) {
    const name = file.title || file.name;
    if (q && !matchesFilter(name, q) && !matchesFilter(file.path, q)) continue;
    const li = document.createElement("li");
    wireFileRow(li, file.path, name, file.title);
    libList.appendChild(li);
  }
}

async function browseTo(path: string): Promise<void> {
  const result = await cmd<BrowseResult>("library.browse", { path });
  browsePath = result.path;
  browseParent = result.parent;
  browseDirs = result.dirs || [];
  browseFiles = result.files || [];
  localStorage.setItem(BROWSE_PATH_KEY, browsePath);
  browsePathEl.textContent = browsePath;
  btnBrowseUp.disabled = !browseParent;
  renderLibrary();
}

async function refreshLibrary(): Promise<void> {
  await cmd("library.scan", { root: musicRoot() });
  const listed = await cmd<{ tracks: LibraryTrack[] }>("library.list");
  library = listed.tracks || [];
  analysisByPath = new Map(library.filter((t) => t.path).map((t) => [t.path, t.analysis]));
  await browseTo(browsePath);
}

function loopLabel(loop: string): string {
  if (loop === "loop") return "Loop";
  if (loop === "loop_one") return "One";
  return "Loop off";
}

function nextLoopValue(current: string): string {
  if (current === "disabled" || !current) return "loop";
  if (current === "loop") return "loop_one";
  return "disabled";
}

async function roonCmd(action: string, params: Record<string, unknown>): Promise<void> {
  try {
    await cmd(action, params);
    log(`${action} ${JSON.stringify(params)}`.slice(0, 120));
    await refreshRoon();
  } catch (e) {
    flash(String(e));
    setBadge(roonBadge, false, true);
  }
}

function renderZoneCard(z: RoonZone): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "zone-card";

  const head = document.createElement("div");
  const np = z.nowPlaying;
  const nowLines = np
    ? `<div class="zone-now"><strong>${np.line1}</strong><div class="meta">${np.line2}${np.line3 ? ` · ${np.line3}` : ""}</div></div>`
    : `<div class="zone-now meta">Nothing playing</div>`;
  head.innerHTML = `<div><strong>${z.displayName}</strong> <span class="meta">${z.state}${z.queueItemsRemaining ? ` · ${z.queueItemsRemaining} queued` : ""}</span></div>${nowLines}`;
  li.appendChild(head);

  const transport = document.createElement("div");
  transport.className = "zone-actions";

  const mkBtn = (label: string, disabled: boolean, onclick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "btn btn--small";
    b.type = "button";
    b.textContent = label;
    b.disabled = disabled;
    b.onclick = (ev) => {
      ev.stopPropagation();
      void onclick();
    };
    return b;
  };

  const playing = z.state === "playing" || z.state === "loading";
  transport.appendChild(
    mkBtn("⏮", !z.isPreviousAllowed, () => roonCmd("roon.control", { zone: z.zoneId, action: "previous" })),
  );
  transport.appendChild(
    mkBtn(playing ? "❚❚" : "▶", playing ? !z.isPauseAllowed : !z.isPlayAllowed, () =>
      roonCmd("roon.control", { zone: z.zoneId, action: "playpause" }),
    ),
  );
  transport.appendChild(mkBtn("■", false, () => roonCmd("roon.control", { zone: z.zoneId, action: "stop" })));
  transport.appendChild(mkBtn("⏭", !z.isNextAllowed, () => roonCmd("roon.control", { zone: z.zoneId, action: "next" })));
  li.appendChild(transport);

  const trackLen = z.nowPlaying?.length ?? null;
  if (trackLen != null && trackLen > 0 && z.isSeekAllowed) {
    const seekRow = document.createElement("div");
    seekRow.className = "zone-seek";
    const seekLabel = document.createElement("span");
    seekLabel.textContent = fmt(z.seekPosition ?? 0);
    const seek = document.createElement("input");
    seek.type = "range";
    seek.min = "0";
    seek.max = "1000";
    const pos = z.seekPosition ?? 0;
    seek.value = String(Math.round((pos / trackLen) * 1000));
    const durLabel = document.createElement("span");
    durLabel.textContent = fmt(trackLen);
    seekRow.append(seekLabel, seek, durLabel);
    li.appendChild(seekRow);

    const seekTo = async () => {
      const seconds = (Number(seek.value) / 1000) * trackLen;
      try {
        await cmd("roon.seek", { zone: z.zoneId, how: "absolute", seconds });
      } catch (e) {
        flash(String(e));
      }
    };
    seek.onpointerdown = (ev) => {
      roonScrubbing.add(z.zoneId);
      seek.setPointerCapture(ev.pointerId);
    };
    seek.onpointerup = seek.onpointercancel = () => {
      roonScrubbing.delete(z.zoneId);
      void seekTo().then(() => refreshRoon());
    };
    let seekTimer: number | null = null;
    seek.oninput = () => {
      seekLabel.textContent = fmt((Number(seek.value) / 1000) * trackLen);
      if (seekTimer != null) return;
      seekTimer = window.setTimeout(() => {
        seekTimer = null;
        void seekTo();
      }, 40);
    };
  }

  if (z.volume && z.volume.min != null && z.volume.max != null && z.volume.value != null) {
    const volRow = document.createElement("div");
    volRow.className = "zone-vol";
    const volMin = z.volume.min;
    const volMax = z.volume.max;
    const volStep = z.volume.step ?? 1;
    const vol = document.createElement("input");
    vol.type = "range";
    vol.min = String(volMin);
    vol.max = String(volMax);
    vol.step = String(volStep);
    vol.value = String(z.volume.value);
    const muteBtn = mkBtn(z.volume.isMuted ? "Unmute" : "Mute", false, () =>
      roonCmd("roon.mute", { zone: z.zoneId, how: z.volume!.isMuted ? "unmute" : "mute" }),
    );
    volRow.append(document.createTextNode("Vol"), vol, muteBtn);
    li.appendChild(volRow);

    let volTimer: number | null = null;
    const setVol = async () => {
      try {
        await cmd("roon.volume", { zone: z.zoneId, how: "absolute", value: Number(vol.value) });
      } catch (e) {
        flash(String(e));
      }
    };
    vol.onpointerdown = () => roonVolChanging.add(z.zoneId);
    vol.onpointerup = vol.onpointercancel = () => {
      roonVolChanging.delete(z.zoneId);
      void setVol().then(() => refreshRoon());
    };
    vol.oninput = () => {
      if (volTimer != null) return;
      volTimer = window.setTimeout(() => {
        volTimer = null;
        void setVol();
      }, 40);
    };
  }

  const toggles = document.createElement("div");
  toggles.className = "zone-toggles";
  const settings = z.settings;
  const shuffleBtn = mkBtn(`Shuffle ${settings?.shuffle ? "on" : "off"}`, false, () =>
    roonCmd("roon.settings", { zone: z.zoneId, shuffle: !settings?.shuffle }),
  );
  shuffleBtn.classList.toggle("is-on", Boolean(settings?.shuffle));
  const loopVal = settings?.loop || "disabled";
  const loopBtn = mkBtn(loopLabel(loopVal), false, () =>
    roonCmd("roon.settings", { zone: z.zoneId, loop: nextLoopValue(loopVal) }),
  );
  loopBtn.classList.toggle("is-on", loopVal === "loop" || loopVal === "loop_one");
  const radioBtn = mkBtn(`Radio ${settings?.autoRadio ? "on" : "off"}`, false, () =>
    roonCmd("roon.settings", { zone: z.zoneId, autoRadio: !settings?.autoRadio }),
  );
  radioBtn.classList.toggle("is-on", Boolean(settings?.autoRadio));
  toggles.append(shuffleBtn, loopBtn, radioBtn);
  li.appendChild(toggles);

  return li;
}

async function refreshRoon(): Promise<void> {
  try {
    const result = await cmd<{ zones: RoonZone[] }>("roon.zones");
    const zones = result.zones || [];
    setBadge(roonBadge, true);
    roonHint.textContent = `${zones.length} zone(s) · transport, seek, volume, shuffle / loop / radio`;
    roonList.innerHTML = "";
    for (const z of zones) {
      roonList.appendChild(renderZoneCard(z));
    }
  } catch (e) {
    setBadge(roonBadge, false, true);
    roonHint.textContent = String(e);
    roonList.innerHTML = "";
  }
}

function wireDeck(deck: DeckName): void {
  byId<HTMLButtonElement>(`deck-${deck}-play`).onclick = async () => {
    try {
      const playing = lastStatus?.decks[deck]?.playing;
      await cmd(playing ? "deck.pause" : "deck.play", { deck });
    } catch (e) {
      flash(String(e));
    }
  };
  byId<HTMLButtonElement>(`deck-${deck}-cue`).onclick = async () => {
    try {
      await cmd("deck.cue", { deck });
    } catch (e) {
      flash(String(e));
    }
  };
  byId<HTMLButtonElement>(`deck-${deck}-setcue`).onclick = async () => {
    try {
      await cmd("deck.setCue", { deck });
      flash(`Cue set on ${deck.toUpperCase()}`);
    } catch (e) {
      flash(String(e));
    }
  };

  const scrub = byId<HTMLInputElement>(`deck-${deck}-scrub`);
  const seekFromScrub = async () => {
    const dur = lastStatus?.decks[deck]?.duration_sec || 0;
    if (dur <= 0) return;
    const positionSec = (Number(scrub.value) / 1000) * dur;
    try {
      await cmd("deck.seek", { deck, positionSec });
    } catch (e) {
      flash(String(e));
    }
  };
  scrub.onpointerdown = (ev) => {
    scrubbing[deck] = true;
    scrub.setPointerCapture(ev.pointerId);
  };
  scrub.onpointerup = scrub.onpointercancel = () => {
    scrubbing[deck] = false;
    void seekFromScrub();
  };
  let scrubTimer: number | null = null;
  scrub.oninput = () => {
    if (scrubTimer != null) return;
    scrubTimer = window.setTimeout(() => {
      scrubTimer = null;
      void seekFromScrub();
    }, 40);
  };

  byId<HTMLDivElement>(`deck-${deck}-wave`).onclick = async (ev) => {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const dur = lastStatus?.decks[deck]?.duration_sec || 0;
    if (dur <= 0) return;
    try {
      await cmd("deck.seek", { deck, positionSec: pct * dur });
    } catch (e) {
      flash(String(e));
    }
  };

  const rate = byId<HTMLInputElement>(`deck-${deck}-rate`);
  rate.oninput = async () => {
    try {
      await cmd("deck.setRate", { deck, rate: Number(rate.value) });
    } catch (e) {
      flash(String(e));
    }
  };

  for (const band of ["low", "mid", "high"] as const) {
    byId<HTMLInputElement>(`deck-${deck}-eq-${band}`).oninput = async (ev) => {
      const value = Number((ev.target as HTMLInputElement).value);
      try {
        await cmd("deck.setEq", { deck, [band]: value });
      } catch (e) {
        flash(String(e));
      }
    };
  }
  byId<HTMLInputElement>(`deck-${deck}-gain`).oninput = async (ev) => {
    try {
      await cmd("deck.setGain", { deck, gain: Number((ev.target as HTMLInputElement).value) });
    } catch (e) {
      flash(String(e));
    }
  };

  const wheel = byId<HTMLDivElement>(`jog-${deck}`);
  let lastX = 0;
  let dragging = false;
  let pendingDelta = 0;
  let jogTimer: number | null = null;
  const flushJog = async () => {
    jogTimer = null;
    const deltaSec = pendingDelta;
    pendingDelta = 0;
    if (Math.abs(deltaSec) < 0.001) return;
    try {
      await cmd("deck.jog", { deck, deltaSec });
    } catch {
      /* ignore spam */
    }
  };
  wheel.onpointerdown = (ev) => {
    dragging = true;
    lastX = ev.clientX;
    wheel.classList.add("is-dragging");
    wheel.setPointerCapture(ev.pointerId);
  };
  wheel.onpointermove = (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - lastX;
    lastX = ev.clientX;
    if (Math.abs(dx) < 1) return;
    pendingDelta += dx * 0.008;
    jogAngle[deck] = (jogAngle[deck] + dx * 0.9) % 360;
    wheel.style.transform = `rotate(${jogAngle[deck]}deg)`;
    if (jogTimer == null) jogTimer = window.setTimeout(() => void flushJog(), 35);
  };
  wheel.onpointerup = wheel.onpointercancel = () => {
    dragging = false;
    wheel.classList.remove("is-dragging");
    void flushJog();
  };

  const deckEl = byId<HTMLElement>(`deck-${deck}`);
  const onDragOver = (ev: DragEvent) => {
    ev.preventDefault();
    deckEl.classList.add("is-dragover");
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = () => deckEl.classList.remove("is-dragover");
  const onDrop = async (ev: DragEvent) => {
    ev.preventDefault();
    deckEl.classList.remove("is-dragover");
    const path =
      ev.dataTransfer?.getData("application/x-madcool-path") ||
      ev.dataTransfer?.getData("text/plain") ||
      "";
    const file = ev.dataTransfer?.files?.[0];
    try {
      if (path && path.startsWith("/") && !file) {
        await loadOntoDeck(deck, path);
        flash(`Dropped → ${deck.toUpperCase()}`);
        return;
      }
      if (file) {
        await uploadOntoDeck(deck, file);
        return;
      }
      if (path.startsWith("/")) {
        await loadOntoDeck(deck, path);
        flash(`Dropped → ${deck.toUpperCase()}`);
      }
    } catch (e) {
      flash(String(e));
    }
  };
  deckEl.addEventListener("dragover", onDragOver);
  deckEl.addEventListener("dragleave", onDragLeave);
  deckEl.addEventListener("drop", onDrop);
}

document.querySelectorAll<HTMLButtonElement>("[data-jog]").forEach((btn) => {
  btn.onclick = async () => {
    const deck = btn.dataset.deck as DeckName;
    const deltaSec = Number(btn.dataset.jog);
    try {
      await cmd("deck.jog", { deck, deltaSec });
    } catch (e) {
      flash(String(e));
    }
  };
});

document.querySelectorAll<HTMLButtonElement>("[data-rate-deck]").forEach((btn) => {
  btn.onclick = async () => {
    const deck = btn.dataset.rateDeck as DeckName;
    const delta = Number(btn.dataset.rateDelta);
    try {
      await cmd("deck.nudgeRate", { deck, delta });
      const st = await getStatus();
      const rate = st.decks[deck].rate ?? 1;
      byId<HTMLInputElement>(`deck-${deck}-rate`).value = String(rate);
    } catch (e) {
      flash(String(e));
    }
  };
});

let xfTimer: number | undefined;
crossfader.oninput = () => {
  crossfaderValue.textContent = Number(crossfader.value).toFixed(2);
  window.clearTimeout(xfTimer);
  xfTimer = window.setTimeout(async () => {
    try {
      await cmd("mixer.crossfade", { position: Number(crossfader.value) });
    } catch (e) {
      flash(String(e));
    }
  }, 40);
};

btnAutopilot.onclick = async () => {
  const on = lastStatus?.autopilot;
  try {
    await cmd(on ? "autopilot.disable" : "autopilot.enable");
  } catch (e) {
    flash(String(e));
  }
};

btnClaim.onclick = async () => {
  try {
    await cmd("device.claim");
    flash("Claimed DAC for local mix");
  } catch (e) {
    flash(String(e));
  }
};

btnRelease.onclick = async () => {
  try {
    await cmd("device.release");
    flash("DAC released");
  } catch (e) {
    flash(String(e));
  }
};

btnAudioMode.onclick = async () => {
  const next = audioMode === "shared" ? "exclusive" : "shared";
  try {
    const info = await cmd<{ mode: string; device_name?: string }>("device.setMode", { mode: next });
    audioMode = info.mode || next;
    btnAudioMode.textContent = `Audio: ${audioMode}`;
    flash(`${audioMode} · ${info.device_name || "default"}`);
  } catch (e) {
    flash(String(e));
  }
};

btnFind.onclick = async () => {
  try {
    libSearch.value = "SamSupa";
    await refreshLibrary();
    const hit = library.find((t) => /samsupa/i.test(t.path) || /samsupa/i.test(t.title || ""));
    if (hit) {
      await loadOntoDeck(loadTarget, hit.path, hit.title || hit.path);
      flash(`Found → deck ${loadTarget.toUpperCase()}: ${hit.title || hit.path}`);
    } else {
      renderLibrary();
      flash("No SamSupa match in scanned library (check ~/Music)");
    }
  } catch (e) {
    flash(String(e));
  }
};

btnLoadFixtures.onclick = async () => {
  try {
    await refreshLibrary();
    const clips = library.filter((t) => /clip_[ab]\.wav$/i.test(t.path));
    const a = clips.find((t) => /clip_a/i.test(t.path)) || clips[0];
    const b = clips.find((t) => /clip_b/i.test(t.path)) || clips[1];
    if (a) await loadOntoDeck("a", a.path, a.title || "clip_a");
    if (b) await loadOntoDeck("b", b.path, b.title || "clip_b");
    flash("Fixtures on A/B");
    log("loaded fixtures");
  } catch (e) {
    flash(String(e));
  }
};

btnScan.onclick = () => void refreshLibrary().catch((e) => flash(String(e)));
btnBrowseUp.onclick = () => {
  if (browseParent) void browseTo(browseParent).catch((e) => flash(String(e)));
};
browsePathEl.title = browsePath;
browsePathEl.onclick = () => {
  void navigator.clipboard.writeText(browsePath).then(
    () => flash("Path copied"),
    () => flash(browsePath),
  );
};
btnRoonRefresh.onclick = () => void refreshRoon();
libSearch.oninput = () => renderLibrary();

tokenInput.value = localStorage.getItem(TOKEN_KEY) || "";
tokenInput.onchange = () => localStorage.setItem(TOKEN_KEY, tokenInput.value);

wireDeck("a");
wireDeck("b");

async function poll(): Promise<void> {
  try {
    const st = await getStatus();
    lastStatus = st;
    engineVersion.textContent = st.version;
    autopilotState.textContent = st.autopilot ? "on" : "off";
    btnAutopilot.classList.toggle("is-on", st.autopilot);
    crossfaderValue.textContent = st.crossfade.toFixed(2);
    if (document.activeElement !== crossfader) crossfader.value = String(st.crossfade);
    if (st.audio?.mode) {
      audioMode = st.audio.mode;
      btnAudioMode.textContent = `Audio: ${audioMode}`;
    }
    updateDeckUi("a", st.decks.a);
    updateDeckUi("b", st.decks.b);
    const seq = st.studio?.seq;
    if (seq) {
      const stepEl = document.getElementById("seq-step");
      if (stepEl) stepEl.textContent = `step ${seq.step_index ?? 0}`;
      const grid = document.getElementById("seq-grid");
      if (grid) {
        const idx = seq.step_index ?? 0;
        grid.querySelectorAll<HTMLButtonElement>(".seq-cell").forEach((cell) => {
          cell.classList.toggle("is-playhead", Number(cell.dataset.step) === idx && !!seq.playing);
        });
      }
    }
    if (st.studio?.sampler?.kit) {
      const label = document.getElementById("studio-kit-label");
      if (label) label.textContent = String(st.studio.sampler.kit).split("/").slice(-2).join("/");
    }
  } catch (e) {
    flash(String(e));
  }
}

function connectWs(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const t = token();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const ws = new WebSocket(`${proto}://${location.host}/v1/live${q}`);
  ws.onopen = () => setBadge(connBadge, true);
  ws.onclose = () => {
    setBadge(connBadge, false);
    window.setTimeout(connectWs, 1500);
  };
  ws.onerror = () => setBadge(connBadge, false, true);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.event === "plan") {
        planBody.innerHTML = `<pre>${JSON.stringify(msg.data, null, 2)}</pre>`;
      }
      if (msg.event) log(`${msg.event} ${JSON.stringify(msg.data ?? {})}`.slice(0, 180));
    } catch {
      /* ignore */
    }
  };
}

connectWs();
void poll();
window.setInterval(() => void poll(), 500);
void browseTo(browsePath).catch(() => undefined);
void refreshRoon();
window.setInterval(() => void refreshRoon(), 8000);
log("dashboard ready");

/* ——— Dubstep studio ——— */
const PADS = ["kick", "snare", "hat", "openhat", "clap", "rim", "bass", "riser", "impact", "sweep", "noise", "kick2"] as const;
const SEQ_TRACKS = ["kick", "snare", "hat", "clap", "fx"] as const;
const seqPatterns: Record<string, number[]> = {
  kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
  snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  clap: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  fx: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

const padGrid = byId<HTMLDivElement>("pad-grid");
const seqGrid = byId<HTMLDivElement>("seq-grid");
const studioKitLabel = byId<HTMLSpanElement>("studio-kit-label");
const seqStepLabel = byId<HTMLSpanElement>("seq-step");
const synthGate = byId<HTMLButtonElement>("synth-gate");

for (const pad of PADS) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn";
  btn.textContent = pad;
  btn.onclick = () => {
    void cmd("sampler.trigger", { pad, velocity: 1 }).then(
      () => {
        btn.classList.add("is-hit");
        window.setTimeout(() => btn.classList.remove("is-hit"), 120);
        log(`pad ${pad}`);
      },
      (e) => flash(String(e)),
    );
  };
  padGrid.appendChild(btn);
}

function renderSeqGrid(): void {
  seqGrid.innerHTML = "";
  for (const track of SEQ_TRACKS) {
    const row = document.createElement("div");
    row.className = "seq-track";
    const label = document.createElement("span");
    label.className = "seq-track-label";
    label.textContent = track;
    row.appendChild(label);
    const steps = seqPatterns[track] ?? Array(16).fill(0);
    for (let i = 0; i < 16; i++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "seq-cell" + (steps[i] ? " is-on" : "");
      cell.dataset.track = track;
      cell.dataset.step = String(i);
      cell.onclick = () => {
        steps[i] = steps[i] ? 0 : 1;
        seqPatterns[track] = steps;
        cell.classList.toggle("is-on", !!steps[i]);
        void cmd("seq.setPattern", { track, steps }).catch((e) => flash(String(e)));
      };
      row.appendChild(cell);
    }
    seqGrid.appendChild(row);
  }
}
renderSeqGrid();

byId<HTMLButtonElement>("btn-kit-load").onclick = () => {
  void cmd<{ kit?: string; pads?: Record<string, string> }>("studio.loadKit", {}).then(
    (r) => {
      studioKitLabel.textContent = r.kit ? r.kit.split("/").slice(-2).join("/") : "none";
      log(`kit ${r.kit} pads=${Object.keys(r.pads || {}).length}`);
    },
    (e) => flash(String(e)),
  );
};

let synthHeld = false;
synthGate.onclick = () => {
  synthHeld = !synthHeld;
  synthGate.classList.toggle("is-on", synthHeld);
  const note = Number(byId<HTMLInputElement>("synth-note").value) || 33;
  if (synthHeld) {
    void cmd("synth.noteOn", { note, velocity: 1 }).catch((e) => flash(String(e)));
  } else {
    void cmd("synth.noteOff", {}).catch((e) => flash(String(e)));
  }
};

function pushSynth(): void {
  void cmd("synth.set", {
    waveform: byId<HTMLSelectElement>("synth-wave").value,
    cutoff: Number(byId<HTMLInputElement>("synth-cut").value),
    resonance: Number(byId<HTMLInputElement>("synth-res").value),
    lfo_hz: Number(byId<HTMLInputElement>("synth-lfo").value),
    lfo_depth: Number(byId<HTMLInputElement>("synth-depth").value),
    gain: Number(byId<HTMLInputElement>("synth-gain").value),
  }).catch((e) => flash(String(e)));
}
for (const id of ["synth-wave", "synth-cut", "synth-res", "synth-lfo", "synth-depth", "synth-gain"]) {
  byId<HTMLElement>(id).addEventListener("change", pushSynth);
  byId<HTMLElement>(id).addEventListener("input", pushSynth);
}

byId<HTMLButtonElement>("seq-play").onclick = () => {
  void cmd("seq.setBpm", { bpm: Number(byId<HTMLInputElement>("seq-bpm").value) || 140 })
    .then(() => Promise.all(SEQ_TRACKS.map((t) => cmd("seq.setPattern", { track: t, steps: seqPatterns[t] }))))
    .then(() => cmd("seq.setBassNotes", { notes: [33, 0, 0, 0, 0, 0, 0, 0, 33, 0, 0, 0, 0, 0, 28, 0] }))
    .then(() => cmd("seq.play", {}))
    .then(() => log("seq play"))
    .catch((e) => flash(String(e)));
};
byId<HTMLButtonElement>("seq-stop").onclick = () => {
  void cmd("seq.stop", {}).then(() => log("seq stop")).catch((e) => flash(String(e)));
};
byId<HTMLButtonElement>("seq-clear").onclick = () => {
  for (const t of SEQ_TRACKS) seqPatterns[t] = Array(16).fill(0);
  renderSeqGrid();
  void cmd("seq.clear", {}).catch((e) => flash(String(e)));
};
byId<HTMLInputElement>("seq-bpm").onchange = () => {
  void cmd("seq.setBpm", { bpm: Number(byId<HTMLInputElement>("seq-bpm").value) || 140 }).catch((e) =>
    flash(String(e)),
  );
};

function pushFx(): void {
  void cmd("fx.set", {
    filter_hz: Number(byId<HTMLInputElement>("fx-filter").value),
    lfo_hz: Number(byId<HTMLInputElement>("fx-lfo").value),
    lfo_depth: Number(byId<HTMLInputElement>("fx-depth").value),
    delay_ms: Number(byId<HTMLInputElement>("fx-delay").value),
    delay_mix: Number(byId<HTMLInputElement>("fx-delay-mix").value),
    crush: Number(byId<HTMLInputElement>("fx-crush").value),
  }).catch((e) => flash(String(e)));
}
for (const id of ["fx-filter", "fx-lfo", "fx-depth", "fx-delay", "fx-delay-mix", "fx-crush"]) {
  byId<HTMLElement>(id).addEventListener("input", pushFx);
}

document.querySelectorAll<HTMLButtonElement>("[data-transition]").forEach((btn) => {
  btn.onclick = () => {
    const name = btn.dataset.transition || "";
    void cmd("transition.run", { name }).then(
      () => log(`transition ${name}`),
      (e) => flash(String(e)),
    );
  };
});

void cmd<{ kit?: string }>("studio.loadKit", {}).then(
  (r) => {
    if (r.kit) studioKitLabel.textContent = r.kit.split("/").slice(-2).join("/");
  },
  () => undefined,
);
/* ——— MiniMax Music Gen ——— */
const MOODS = [
  "dark", "melancholic", "euphoric", "aggressive", "hypnotic", "nostalgic",
  "cinematic", "intimate", "defiant", "playful", "menacing", "uplifting",
];
const INSTRUMENTS = [
  "wobble bass", "808 sub", "Reese bass", "half-time drums", "rolling hats",
  "neuro growls", "synth pads", "piano", "electric guitar", "brass stabs",
  "vocal chops", "risers", "glitch FX", "strings",
];

const genStatus = byId<HTMLSpanElement>("gen-status");
const genPrompt = byId<HTMLTextAreaElement>("gen-prompt");
const genLyrics = byId<HTMLTextAreaElement>("gen-lyrics");
const genJobEl = byId<HTMLDivElement>("gen-job");
const genJobList = byId<HTMLUListElement>("gen-job-list");
const genRefDrop = byId<HTMLDivElement>("gen-ref-drop");
const genRefMeta = byId<HTMLDivElement>("gen-ref-meta");
const genRefHint = byId<HTMLSpanElement>("gen-ref-hint");
const genBpm = byId<HTMLInputElement>("gen-bpm");
const genBpmVal = byId<HTMLSpanElement>("gen-bpm-val");

let genRefPath: string | null = null;
let genPollTimer: number | null = null;

function mountChips(containerId: string, items: string[], maxOn = 4): void {
  const el = byId<HTMLDivElement>(containerId);
  for (const item of items) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "gen-chip";
    chip.textContent = item;
    chip.dataset.value = item;
    chip.onclick = () => {
      const on = chip.classList.toggle("is-on");
      if (on) {
        const selected = [...el.querySelectorAll(".gen-chip.is-on")];
        if (selected.length > maxOn) selected[0]?.classList.remove("is-on");
      }
      void previewGenPrompt();
    };
    el.appendChild(chip);
  }
}
mountChips("gen-moods", MOODS, 3);
mountChips("gen-instruments", INSTRUMENTS, 5);

function selectedChips(containerId: string): string[] {
  return [...byId<HTMLDivElement>(containerId).querySelectorAll<HTMLButtonElement>(".gen-chip.is-on")].map(
    (c) => c.dataset.value || c.textContent || "",
  );
}

function collectGenSettings(): Record<string, unknown> {
  let genre = byId<HTMLSelectElement>("gen-genre").value;
  if (genre === "Custom…") genre = byId<HTMLInputElement>("gen-subgenre").value || "Electronic";
  return {
    bpm: Number(genBpm.value),
    key: byId<HTMLSelectElement>("gen-key").value || null,
    genre,
    subgenre: byId<HTMLInputElement>("gen-subgenre").value || null,
    moods: selectedChips("gen-moods"),
    instruments: selectedChips("gen-instruments"),
    complexity: byId<HTMLSelectElement>("gen-complexity").value,
    energy: byId<HTMLSelectElement>("gen-energy").value,
    vocals: byId<HTMLSelectElement>("gen-vocals").value,
    vocalStyle: byId<HTMLInputElement>("gen-vocal-style").value || null,
    atmosphere: byId<HTMLInputElement>("gen-atmosphere").value || null,
    theme: byId<HTMLInputElement>("gen-theme").value || null,
    avoid: byId<HTMLInputElement>("gen-avoid").value || null,
    useCase: byId<HTMLInputElement>("gen-usecase").value || null,
    era: byId<HTMLInputElement>("gen-era").value || null,
    extras: byId<HTMLInputElement>("gen-extras").value || null,
  };
}

async function previewGenPrompt(): Promise<void> {
  try {
    const mode = byId<HTMLSelectElement>("gen-mode").value;
    const res = await cmd<{ prompt: string }>("music.previewPrompt", {
      ...collectGenSettings(),
      mode,
      prompt: "",
    });
    if (document.activeElement !== genPrompt) genPrompt.value = res.prompt;
  } catch (e) {
    flash(String(e));
  }
}

async function useReferencePath(path: string): Promise<void> {
  flash("Analyzing reference…");
  const res = await cmd<{
    path: string;
    title?: string | null;
    artist?: string | null;
    bpm?: number | null;
    genre?: string | null;
    duration_sec?: number | null;
    prompt?: string;
    settings?: Record<string, unknown>;
  }>("music.analyzeRef", { path });
  genRefPath = res.path;
  genRefHint.textContent = path.split("/").slice(-2).join("/");
  genRefMeta.classList.remove("hidden");
  genRefMeta.textContent = [
    res.artist || "—",
    res.title || "—",
    res.bpm ? `${res.bpm} BPM` : null,
    res.genre || null,
    res.duration_sec ? `${Math.round(res.duration_sec)}s` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (res.bpm) {
    genBpm.value = String(Math.round(res.bpm));
    genBpmVal.textContent = genBpm.value;
  }
  if (res.genre) {
    const sel = byId<HTMLSelectElement>("gen-genre");
    const opt = [...sel.options].find((o) => o.value.toLowerCase() === res.genre!.toLowerCase());
    if (opt) sel.value = opt.value;
    else {
      sel.value = "Custom…";
      byId<HTMLInputElement>("gen-subgenre").value = res.genre;
    }
  }
  if (res.settings?.atmosphere) {
    byId<HTMLInputElement>("gen-atmosphere").value = String(res.settings.atmosphere);
  }
  if (res.settings?.theme) {
    byId<HTMLInputElement>("gen-theme").value = String(res.settings.theme);
  }
  byId<HTMLDivElement>("gen-moods").querySelectorAll<HTMLButtonElement>(".gen-chip").forEach((c) => {
    if (["hypnotic", "dark", "nostalgic"].includes(c.dataset.value || "")) c.classList.add("is-on");
  });
  if (res.prompt) genPrompt.value = res.prompt;
  else await previewGenPrompt();
  log(`ref ${res.artist || "?"} — ${res.title || path}`);
  flash("Reference seeded Music Gen");
}

genBpm.oninput = () => {
  genBpmVal.textContent = genBpm.value;
  void previewGenPrompt();
};
for (const id of [
  "gen-mode", "gen-key", "gen-genre", "gen-subgenre", "gen-era", "gen-complexity",
  "gen-energy", "gen-vocals", "gen-vocal-style", "gen-atmosphere", "gen-theme",
  "gen-avoid", "gen-usecase", "gen-extras",
]) {
  byId<HTMLElement>(id).addEventListener("change", () => void previewGenPrompt());
}

byId<HTMLSelectElement>("gen-mode").addEventListener("change", () => {
  const mode = byId<HTMLSelectElement>("gen-mode").value;
  const model = byId<HTMLSelectElement>("gen-model");
  if (mode === "cover") model.value = "music-cover";
  else if (model.value.startsWith("music-cover")) model.value = "music-3.0";
});

byId<HTMLButtonElement>("btn-gen-preview").onclick = () => {
  void cmd<{ prompt: string }>("music.previewPrompt", {
    ...collectGenSettings(),
    mode: byId<HTMLSelectElement>("gen-mode").value,
  }).then((r) => {
    genPrompt.value = r.prompt;
    flash("Prompt composed");
  }, (e) => flash(String(e)));
};

byId<HTMLButtonElement>("btn-gen-scaffold").onclick = () => {
  const theme = byId<HTMLInputElement>("gen-theme").value || "midnight signal cutting through the noise";
  genLyrics.value = `[Intro]\n(pulse)\n\n[Verse]\n${theme}\nlooking for the perfect line\n\n[Pre Chorus]\ncloser now\n\n[Chorus]\nCool the data, raise the gain\nlet the signal cut the rain\n\n[Verse]\nanother pass, another try\n\n[Chorus]\nCool the data, raise the gain\nlet the signal cut the rain\n\n[Outro]\n(soft close)`;
  byId<HTMLSelectElement>("gen-vocals").value = "male";
};

byId<HTMLButtonElement>("btn-gen-lyrics").onclick = () => {
  void cmd<{ lyrics: string; source: string }>("music.lyrics", {
    ...collectGenSettings(),
    prompt: genPrompt.value,
  }).then((r) => {
    genLyrics.value = r.lyrics;
    flash(`Lyrics (${r.source})`);
  }, (e) => flash(String(e)));
};

function renderJob(job: {
  id: string;
  status: string;
  error?: string;
  result?: { path?: string; duration_ms?: number | null };
}): void {
  genJobEl.className = "gen-job";
  if (job.status === "running" || job.status === "queued") genJobEl.classList.add("is-running");
  if (job.status === "done") genJobEl.classList.add("is-done");
  if (job.status === "error") genJobEl.classList.add("is-error");
  const dur = job.result?.duration_ms ? `${Math.round(job.result.duration_ms / 1000)}s` : "";
  genJobEl.textContent = [job.status.toUpperCase(), job.id.slice(0, 8), job.result?.path?.split("/").pop(), dur, job.error]
    .filter(Boolean)
    .join(" · ");
}

async function pollGenJob(id: string): Promise<void> {
  if (genPollTimer) window.clearInterval(genPollTimer);
  const tick = async () => {
    try {
      const job = await cmd<{
        id: string;
        status: string;
        error?: string;
        result?: { path?: string; duration_ms?: number | null };
      }>("music.job", { id });
      renderJob(job);
      if (job.status === "done" && job.result?.path) {
        if (genPollTimer) window.clearInterval(genPollTimer);
        genPollTimer = null;
        log(`generated ${job.result.path}`);
        flash("Generation complete");
        if (byId<HTMLInputElement>("gen-autoload").checked) {
          await loadOntoDeck("a", job.result.path);
        }
        void refreshMusicStatus();
      } else if (job.status === "error") {
        if (genPollTimer) window.clearInterval(genPollTimer);
        genPollTimer = null;
        flash(job.error || "generate failed");
      }
    } catch (e) {
      flash(String(e));
    }
  };
  await tick();
  genPollTimer = window.setInterval(() => void tick(), 2500);
}

byId<HTMLButtonElement>("btn-gen-go").onclick = () => {
  const mode = byId<HTMLSelectElement>("gen-mode").value;
  const payload: Record<string, unknown> = {
    ...collectGenSettings(),
    mode,
    model: byId<HTMLSelectElement>("gen-model").value,
    prompt: genPrompt.value.trim(),
    lyrics: genLyrics.value.trim() || undefined,
    format: byId<HTMLSelectElement>("gen-format").value,
    is_instrumental: byId<HTMLSelectElement>("gen-vocals").value === "none",
  };
  if (mode === "cover") {
    if (!genRefPath) {
      flash("Drop a reference track first for cover mode");
      return;
    }
    payload.ref_path = genRefPath;
    payload.preprocess = !!genLyrics.value.trim();
  }
  genJobEl.className = "gen-job is-running";
  genJobEl.textContent = "Queued… MiniMax often takes 1–3 minutes.";
  void cmd<{ id: string; status: string }>("music.generate", payload).then(
    (job) => {
      renderJob(job);
      void pollGenJob(job.id);
    },
    (e) => {
      genJobEl.className = "gen-job is-error";
      genJobEl.textContent = String(e);
      flash(String(e));
    },
  );
};

async function refreshMusicStatus(): Promise<void> {
  try {
    const st = await cmd<{
      configured: boolean;
      jobs: Array<{ id: string; status: string; prompt?: string; result?: { path?: string } }>;
    }>("music.status");
    genStatus.textContent = st.configured ? "API ready" : "no API key";
    genJobList.innerHTML = "";
    for (const j of st.jobs || []) {
      const li = document.createElement("li");
      li.textContent = `${j.status} · ${j.result?.path?.split("/").pop() || j.prompt?.slice(0, 40) || j.id.slice(0, 8)}`;
      li.onclick = () => {
        if (j.result?.path) void loadOntoDeck(loadTarget, j.result.path);
        else void pollGenJob(j.id);
      };
      genJobList.appendChild(li);
    }
  } catch {
    genStatus.textContent = "offline";
  }
}

genRefDrop.ondragover = (ev) => {
  ev.preventDefault();
  genRefDrop.classList.add("is-dragover");
};
genRefDrop.ondragenter = (ev) => {
  ev.preventDefault();
  genRefDrop.classList.add("is-dragover");
};
genRefDrop.ondragleave = () => genRefDrop.classList.remove("is-dragover");
genRefDrop.ondrop = (ev) => {
  ev.preventDefault();
  genRefDrop.classList.remove("is-dragover");
  const path =
    ev.dataTransfer?.getData("application/x-madcool-path") || ev.dataTransfer?.getData("text/plain");
  if (path && path.startsWith("/")) {
    void useReferencePath(path).catch((e) => flash(String(e)));
    return;
  }
  const file = ev.dataTransfer?.files?.[0];
  if (!file) {
    flash("Drop a library file (from Files list) for reference analysis");
    return;
  }
  void (async () => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/v1/upload", { method: "POST", headers: { ...authHeaders() }, body: fd });
    const body = (await res.json()) as { ok: boolean; result?: { path?: string }; error?: string };
    if (!body.ok || !body.result?.path) throw new Error(body.error || "upload_failed");
    await useReferencePath(body.result.path);
  })().catch((e) => flash(String(e)));
};

void refreshMusicStatus();
void previewGenPrompt();
window.setInterval(() => void refreshMusicStatus(), 15000);
