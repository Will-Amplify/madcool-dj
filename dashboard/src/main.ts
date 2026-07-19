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
}

interface LibraryTrack {
  path: string;
  title?: string;
  analysis?: {
    bpm?: number | null;
    duration_sec?: number | null;
    bands?: Record<string, number> | null;
    energy?: number[] | null;
  };
}

interface RoonZone {
  zoneId: string;
  displayName: string;
  state: string;
  nowPlaying: { line1: string; line2: string; line3: string } | null;
}

interface CmdResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

const BAND_KEYS = ["sub", "bass", "low_mid", "high_mid", "hats"] as const;
const TOKEN_KEY = "madcool-dj.token";
const LOAD_DECK_KEY = "madcool-dj.loadDeck";

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
const btnLoadFixtures = byId<HTMLButtonElement>("btn-load-fixtures");
const btnScan = byId<HTMLButtonElement>("btn-scan");
const btnRoonRefresh = byId<HTMLButtonElement>("btn-roon-refresh");

let library: LibraryTrack[] = [];
let analysisByPath = new Map<string, LibraryTrack["analysis"]>();
let loadTarget: DeckName = (localStorage.getItem(LOAD_DECK_KEY) as DeckName) || "a";
let scrubbing: Record<DeckName, boolean> = { a: false, b: false };
let lastStatus: StatusResult | null = null;

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

function drawWave(deck: DeckName, energy: number[] | null | undefined, pos: number, dur: number): void {
  const canvas = byId<HTMLCanvasElement>(`deck-${deck}-canvas`);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#050807";
  ctx.fillRect(0, 0, w, h);
  const color = deck === "a" ? "#2fd8c4" : "#5ab0e8";
  const samples = energy && energy.length > 4 ? energy : Array.from({ length: 64 }, (_, i) => 0.2 + 0.15 * Math.sin(i / 5));
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
  const playhead = byId<HTMLDivElement>(`deck-${deck}-playhead`);
  const pct = dur > 0 ? Math.min(1, pos / dur) : 0;
  playhead.style.left = `${pct * 100}%`;
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
  byId<HTMLSpanElement>(`deck-${deck}-bpm`).textContent = analysis?.bpm ? analysis.bpm.toFixed(1) : "—";
  renderBands(deck, analysis?.bands ?? null);
  drawWave(deck, analysis?.energy ?? null, d.position_sec, d.duration_sec || 0);
  const src = byId<HTMLSelectElement>(`deck-${deck}-source`);
  if (d.source && src.value !== d.source && !["spotify", "tidal"].includes(d.source)) {
    src.value = d.source === "roon" ? "roon" : "local";
  }
}

function renderLibrary(): void {
  const q = libSearch.value.trim().toLowerCase();
  libList.innerHTML = "";
  for (const t of library) {
    const name = t.title || t.path.split("/").pop() || t.path;
    if (q && !name.toLowerCase().includes(q) && !t.path.toLowerCase().includes(q)) continue;
    const li = document.createElement("li");
    const bpm = t.analysis?.bpm ? `${t.analysis.bpm.toFixed(0)} bpm` : "";
    li.innerHTML = `<span>${name}</span><span class="meta">${bpm}</span>`;
    li.title = `Load to deck ${loadTarget.toUpperCase()}: ${t.path}`;
    li.onclick = async () => {
      try {
        const source = byId<HTMLSelectElement>(`deck-${loadTarget}-source`).value;
        if (source === "roon") {
          flash("Switch source to Local to load files into the mix bus");
          return;
        }
        if (source === "spotify" || source === "tidal") {
          flash(`${source} stub — not configured`);
          return;
        }
        await cmd("deck.load", { deck: loadTarget, path: t.path, source: "local", title: name });
        log(`load ${loadTarget}: ${name}`);
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
    libList.appendChild(li);
  }
}

async function refreshLibrary(): Promise<void> {
  await cmd("library.scan", { root: localStorage.getItem("madcool-dj.musicRoot") || "/home/madcoolseed/Music" });
  const listed = await cmd<{ tracks: LibraryTrack[] }>("library.list");
  library = listed.tracks || [];
  analysisByPath = new Map(library.filter((t) => t.path).map((t) => [t.path, t.analysis]));
  renderLibrary();
}

async function refreshRoon(): Promise<void> {
  try {
    const result = await cmd<{ zones: RoonZone[] }>("roon.zones");
    const zones = result.zones || [];
    setBadge(roonBadge, true);
    roonHint.textContent = `${zones.length} zone(s) · paired with Simon`;
    roonList.innerHTML = "";
    for (const z of zones) {
      const li = document.createElement("li");
      const now = z.nowPlaying ? `${z.nowPlaying.line1}` : "—";
      li.innerHTML = `<div><strong>${z.displayName}</strong><div class="meta">${z.state} · ${now}</div></div>`;
      const actions = document.createElement("div");
      actions.className = "zone-actions";
      for (const action of ["play", "pause", "next"] as const) {
        const b = document.createElement("button");
        b.className = "btn btn--small";
        b.type = "button";
        b.textContent = action;
        b.onclick = async (ev) => {
          ev.stopPropagation();
          try {
            await cmd("roon.control", { zone: z.zoneId, action });
            log(`roon ${action} ${z.displayName}`);
            await refreshRoon();
          } catch (e) {
            flash(String(e));
            setBadge(roonBadge, false, true);
          }
        };
        actions.appendChild(b);
      }
      li.appendChild(actions);
      roonList.appendChild(li);
    }
  } catch (e) {
    setBadge(roonBadge, false, true);
    roonHint.textContent = String(e);
    roonList.innerHTML = "";
  }
}

function wireDeck(deck: DeckName): void {
  byId<HTMLButtonElement>(`deck-${deck}-play`).onclick = async () => {
    const playing = lastStatus?.decks[deck]?.playing;
    try {
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
  scrub.onpointerdown = () => {
    scrubbing[deck] = true;
  };
  scrub.onpointerup = scrub.onpointerleave = () => {
    scrubbing[deck] = false;
  };
  scrub.onchange = async () => {
    const dur = lastStatus?.decks[deck]?.duration_sec || 0;
    const positionSec = (Number(scrub.value) / 1000) * dur;
    try {
      await cmd("deck.seek", { deck, positionSec });
    } catch (e) {
      flash(String(e));
    }
  };

  byId<HTMLDivElement>(`deck-${deck}-wave`).onclick = async (ev) => {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const dur = lastStatus?.decks[deck]?.duration_sec || 0;
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

  byId<HTMLSelectElement>(`deck-${deck}-source`).onchange = (ev) => {
    const v = (ev.target as HTMLSelectElement).value;
    if (v === "roon") {
      flash(`Deck ${deck.toUpperCase()} source=Roon — use zone controls (mix bus stays local)`);
      loadTarget = deck;
      localStorage.setItem(LOAD_DECK_KEY, deck);
    } else if (v === "local") {
      flash(`Deck ${deck.toUpperCase()} source=Local — click library tracks to load`);
      loadTarget = deck;
      localStorage.setItem(LOAD_DECK_KEY, deck);
    }
  };

  // jog wheel drag
  const wheel = byId<HTMLDivElement>(`jog-${deck}`);
  let lastX = 0;
  let dragging = false;
  wheel.onpointerdown = (ev) => {
    dragging = true;
    lastX = ev.clientX;
    wheel.setPointerCapture(ev.pointerId);
  };
  wheel.onpointermove = async (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - lastX;
    lastX = ev.clientX;
    if (Math.abs(dx) < 2) return;
    try {
      await cmd("deck.jog", { deck, deltaSec: dx * 0.01 });
    } catch {
      /* ignore spam */
    }
  };
  wheel.onpointerup = wheel.onpointercancel = () => {
    dragging = false;
  };
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
    flash("Claimed default sink");
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
    if (a) await cmd("deck.load", { deck: "a", path: a.path, source: "local", title: a.title || "clip_a" });
    if (b) await cmd("deck.load", { deck: "b", path: b.path, source: "local", title: b.title || "clip_b" });
    flash("Fixtures on A/B");
    log("loaded fixtures");
  } catch (e) {
    flash(String(e));
  }
};

btnScan.onclick = () => void refreshLibrary().catch((e) => flash(String(e)));
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
void refreshLibrary().catch(() => undefined);
void refreshRoon();
window.setInterval(() => void refreshRoon(), 8000);
log("dashboard ready");
