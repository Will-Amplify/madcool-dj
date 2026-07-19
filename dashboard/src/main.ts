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
    loadTarget = loadTarget === "a" ? "b" : "a";
    localStorage.setItem(LOAD_DECK_KEY, loadTarget);
    flash(`Load target: deck ${loadTarget.toUpperCase()}`);
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
