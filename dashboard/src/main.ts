import "./style.css";

/**
 * MadCool DJ dashboard — vanilla TS control surface for dj-control's HTTP +
 * WebSocket command bus (see control/src/routes.ts, control/src/ws.ts).
 *
 * No framework: this is a small, mostly-imperative app that polls
 * `/v1/status` for deck/mixer state (the engine doesn't push continuous
 * `levels`/`bands` events yet — see engine/src/madcool_dj_engine/commands.py),
 * layers in cached analysis via `/v1/cmd library.list` for BPM/band data,
 * and appends every `/v1/live` WebSocket event to an activity log.
 */

type DeckName = "a" | "b";

interface DeckSummary {
  path: string | null;
  playing: boolean;
  position_sec: number;
}

interface StatusResult {
  engine: string;
  version: string;
  crossfade: number;
  decks: { a: DeckSummary; b: DeckSummary };
  autopilot: boolean;
}

interface TrackAnalysis {
  bpm?: number | null;
  duration_sec?: number | null;
  bands?: Record<string, number> | null;
}

interface LibraryTrack {
  path: string;
  analysis?: TrackAnalysis;
}

interface CmdResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

const BAND_KEYS = ["sub", "bass", "low_mid", "high_mid", "hats"] as const;
const BAND_LABELS: Record<string, string> = {
  sub: "sub",
  bass: "bass",
  low_mid: "l-mid",
  high_mid: "h-mid",
  hats: "hats",
};

const TOKEN_KEY = "madcool-dj.token";
const STATUS_POLL_MS = 1000;
const LIBRARY_POLL_MS = 4000;
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 10_000;
const LOG_MAX_LINES = 250;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const tokenInput = byId<HTMLInputElement>("token-input");
const connBadge = byId<HTMLDivElement>("conn-badge");
const transportStatus = byId<HTMLSpanElement>("transport-status");

const btnLoadFixtures = byId<HTMLButtonElement>("btn-load-fixtures");
const btnPlayA = byId<HTMLButtonElement>("btn-play-a");
const btnPlayB = byId<HTMLButtonElement>("btn-play-b");
const btnAutopilot = byId<HTMLButtonElement>("btn-autopilot");
const btnClaim = byId<HTMLButtonElement>("btn-claim");

const crossfader = byId<HTMLInputElement>("crossfader");
const crossfaderValue = byId<HTMLDivElement>("crossfader-value");
const autopilotState = byId<HTMLSpanElement>("autopilot-state");
const engineVersion = byId<HTMLSpanElement>("engine-version");

const planBody = byId<HTMLDivElement>("plan-body");
const logBody = byId<HTMLDivElement>("log-body");

const deckEls = {
  a: {
    state: byId<HTMLSpanElement>("deck-a-state"),
    path: byId<HTMLParagraphElement>("deck-a-path"),
    bpm: byId<HTMLSpanElement>("deck-a-bpm"),
    pos: byId<HTMLSpanElement>("deck-a-pos"),
    bands: byId<HTMLDivElement>("deck-a-bands"),
  },
  b: {
    state: byId<HTMLSpanElement>("deck-b-state"),
    path: byId<HTMLParagraphElement>("deck-b-path"),
    bpm: byId<HTMLSpanElement>("deck-b-bpm"),
    pos: byId<HTMLSpanElement>("deck-b-pos"),
    bands: byId<HTMLDivElement>("deck-b-bands"),
  },
} as const;

// -- token -------------------------------------------------------------

function getToken(): string {
  return tokenInput.value.trim();
}

tokenInput.value = localStorage.getItem(TOKEN_KEY) ?? "";
tokenInput.addEventListener("input", () => {
  localStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
});

// -- HTTP command bus ---------------------------------------------------

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}

async function cmd<T = unknown>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await apiFetch("/v1/cmd", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: name, params }),
  });
  let body: CmdResponse<T>;
  try {
    body = (await res.json()) as CmdResponse<T>;
  } catch {
    throw new Error(`bad_response: ${name} (${res.status})`);
  }
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `cmd_failed: ${name}`);
  }
  return body.result as T;
}

async function fetchStatus(): Promise<StatusResult> {
  const res = await apiFetch("/v1/status");
  const body = (await res.json()) as CmdResponse<StatusResult>;
  if (!res.ok || !body.ok) throw new Error(body.error ?? "status_failed");
  return body.result as StatusResult;
}

// -- formatting ----------------------------------------------------------

function formatPosition(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function shortPath(path: string | null): string {
  if (!path) return "no track loaded";
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function nowClock(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

// -- activity log ---------------------------------------------------------

function logLine(evt: string, data: unknown, isError = false): void {
  const line = document.createElement("div");
  line.className = "log-line" + (isError ? " is-error" : "");

  const time = document.createElement("span");
  time.className = "t";
  time.textContent = nowClock();

  const name = document.createElement("span");
  name.className = "evt";
  name.textContent = evt;

  const payload = document.createElement("span");
  payload.className = "data";
  payload.textContent = data === undefined ? "" : safeJson(data);

  line.append(time, name, payload);
  logBody.prepend(line);

  while (logBody.childElementCount > LOG_MAX_LINES) {
    logBody.lastElementChild?.remove();
  }
}

function safeJson(data: unknown): string {
  try {
    const str = JSON.stringify(data);
    return str.length > 160 ? `${str.slice(0, 160)}…` : str;
  } catch {
    return String(data);
  }
}

// -- plan card ---------------------------------------------------------

interface PlanEvent {
  from: string;
  to: string;
  path: string;
  bpm?: number | null;
  remaining_sec?: number;
  ramp_sec?: number;
}

function renderPlan(plan: PlanEvent): void {
  planBody.innerHTML = "";
  const rows: [string, string][] = [
    ["transition", `${plan.from.toUpperCase()} → ${plan.to.toUpperCase()}`],
    ["next up", shortPath(plan.path)],
    ["bpm", plan.bpm != null ? plan.bpm.toFixed(1) : "—"],
    ["fired at", `${plan.remaining_sec ?? "—"}s remaining`],
    ["ramp", `${plan.ramp_sec ?? "—"}s`],
  ];
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "plan-row";
    const kEl = document.createElement("span");
    kEl.className = "k";
    kEl.textContent = k;
    const vEl = document.createElement("span");
    vEl.className = "v";
    vEl.textContent = v;
    row.append(kEl, vEl);
    planBody.appendChild(row);
  }
}

// -- band meters ---------------------------------------------------------

function renderBands(container: HTMLDivElement, bands: Record<string, number> | null | undefined): void {
  container.innerHTML = "";
  if (!bands) return;
  for (const key of BAND_KEYS) {
    const value = Math.max(0, Math.min(1, bands[key] ?? 0));
    const bar = document.createElement("div");
    bar.className = "band-bar";

    const track = document.createElement("div");
    track.className = "band-bar-track";
    const fill = document.createElement("div");
    fill.className = "band-bar-fill";
    fill.style.height = `${Math.round(value * 100)}%`;
    track.appendChild(fill);

    const label = document.createElement("span");
    label.className = "band-bar-label";
    label.textContent = BAND_LABELS[key] ?? key;

    bar.append(track, label);
    container.appendChild(bar);
  }
}

// -- connection badge -----------------------------------------------------

function setConnected(connected: boolean): void {
  connBadge.classList.toggle("badge--on", connected);
  connBadge.classList.toggle("badge--off", !connected);
  connBadge.querySelector(".badge-label")!.textContent = connected ? "control ws · live" : "control ws · offline";
}

// -- status polling ---------------------------------------------------------

let draggingCrossfader = false;
let libraryAnalysis = new Map<string, TrackAnalysis>();
let latestAutopilot = false;

function applyStatus(status: StatusResult): void {
  engineVersion.textContent = `${status.engine} v${status.version}`;

  latestAutopilot = status.autopilot;
  autopilotState.textContent = status.autopilot ? "on" : "off";
  autopilotState.style.color = status.autopilot ? "var(--teal)" : "var(--ink)";
  btnAutopilot.classList.toggle("is-active", status.autopilot);
  btnAutopilot.textContent = status.autopilot ? "Disable autopilot" : "Enable autopilot";

  if (!draggingCrossfader) {
    crossfader.value = String(status.crossfade);
    crossfaderValue.textContent = status.crossfade.toFixed(2);
  }

  applyDeck("a", status.decks.a);
  applyDeck("b", status.decks.b);
}

function applyDeck(name: DeckName, deck: DeckSummary): void {
  const els = deckEls[name];
  els.state.textContent = deck.playing ? "playing" : deck.path ? "paused" : "idle";
  els.state.classList.toggle("is-playing", deck.playing);
  els.path.textContent = shortPath(deck.path);
  els.path.title = deck.path ?? "";
  els.pos.textContent = formatPosition(deck.position_sec);

  const analysis = deck.path ? libraryAnalysis.get(deck.path) : undefined;
  els.bpm.textContent = analysis?.bpm != null ? analysis.bpm.toFixed(1) : "—";
  renderBands(els.bands, analysis?.bands);
}

async function pollStatus(): Promise<void> {
  try {
    const status = await fetchStatus();
    applyStatus(status);
    setStatusOk();
  } catch (err) {
    setStatusError(err);
  }
}

async function pollLibrary(): Promise<void> {
  try {
    const result = await cmd<{ tracks: LibraryTrack[] }>("library.list");
    const next = new Map<string, TrackAnalysis>();
    for (const track of result.tracks) {
      if (track.analysis) next.set(track.path, track.analysis);
    }
    libraryAnalysis = next;
  } catch {
    // library.list is best-effort background enrichment — status polling
    // already surfaces connectivity problems, so stay quiet here.
  }
}

function setStatusOk(): void {
  if (!transportStatus.classList.contains("is-error")) return;
  transportStatus.classList.remove("is-error");
  transportStatus.textContent = "";
}

function setStatusError(err: unknown): void {
  transportStatus.classList.add("is-error");
  transportStatus.textContent = err instanceof Error ? err.message : String(err);
}

// -- WebSocket -------------------------------------------------------------

let ws: WebSocket | null = null;
let wsReconnectDelay = WS_RECONNECT_BASE_MS;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function wsUrl(): string {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const base = `${protocol}://${location.hostname}:8787/v1/live`;
  const token = getToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function connectWs(): void {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  const socket = new WebSocket(wsUrl());
  ws = socket;

  socket.addEventListener("open", () => {
    wsReconnectDelay = WS_RECONNECT_BASE_MS;
    setConnected(true);
  });

  socket.addEventListener("message", (msg) => {
    let payload: { event?: string; data?: unknown };
    try {
      payload = JSON.parse(msg.data as string);
    } catch {
      return;
    }
    const evt = payload.event ?? "message";
    if (evt === "hello") return; // WS handshake noise, not worth logging
    logLine(evt, payload.data);
    if (evt === "plan") renderPlan(payload.data as PlanEvent);
    if (evt === "engine.hello" || evt === "engine.disconnected") {
      pollStatus();
    }
  });

  socket.addEventListener("close", () => {
    setConnected(false);
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

function scheduleReconnect(): void {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWs();
  }, wsReconnectDelay);
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX_MS);
}

// -- buttons ---------------------------------------------------------------

async function withButton(button: HTMLButtonElement, label: string, fn: () => Promise<void>): Promise<void> {
  button.disabled = true;
  try {
    await fn();
    setStatusOk();
  } catch (err) {
    setStatusError(err);
    logLine(`${label}.error`, err instanceof Error ? err.message : String(err), true);
  } finally {
    button.disabled = false;
  }
}

btnLoadFixtures.addEventListener("click", () =>
  withButton(btnLoadFixtures, "load_fixtures", async () => {
    const scan = await cmd<{ root: string; count: number }>("library.scan");
    logLine("library.scan", scan);
    const listing = await cmd<{ tracks: LibraryTrack[] }>("library.list");
    const clipA = listing.tracks.find((t) => t.path.endsWith("clip_a.wav"));
    const clipB = listing.tracks.find((t) => t.path.endsWith("clip_b.wav"));
    if (!clipA || !clipB) {
      throw new Error("clip_a.wav / clip_b.wav not found under scanned root");
    }
    const a = await cmd("deck.load", { deck: "a", path: clipA.path });
    logLine("deck.load", { deck: "a", ...(a as object) });
    const b = await cmd("deck.load", { deck: "b", path: clipB.path });
    logLine("deck.load", { deck: "b", ...(b as object) });
    await pollLibrary();
    await pollStatus();
  }),
);

btnPlayA.addEventListener("click", () =>
  withButton(btnPlayA, "deck_play_a", async () => {
    const result = await cmd("deck.play", { deck: "a" });
    logLine("deck.play", { deck: "a", ...(result as object) });
    await pollStatus();
  }),
);

btnPlayB.addEventListener("click", () =>
  withButton(btnPlayB, "deck_play_b", async () => {
    const result = await cmd("deck.play", { deck: "b" });
    logLine("deck.play", { deck: "b", ...(result as object) });
    await pollStatus();
  }),
);

btnAutopilot.addEventListener("click", () =>
  withButton(btnAutopilot, "autopilot", async () => {
    const enable = !latestAutopilot;
    const result = await cmd(enable ? "autopilot.enable" : "autopilot.disable");
    logLine(enable ? "autopilot.enable" : "autopilot.disable", result);
    await pollStatus();
  }),
);

btnClaim.addEventListener("click", () =>
  withButton(btnClaim, "device_claim", async () => {
    const result = await cmd("device.claim");
    logLine("device.claim", result);
  }),
);

// -- crossfader --------------------------------------------------------

let crossfadeSendTimer: ReturnType<typeof setTimeout> | null = null;

crossfader.addEventListener("pointerdown", () => {
  draggingCrossfader = true;
});
crossfader.addEventListener("pointerup", () => {
  draggingCrossfader = false;
});

crossfader.addEventListener("input", () => {
  const value = Number(crossfader.value);
  crossfaderValue.textContent = value.toFixed(2);

  if (crossfadeSendTimer) clearTimeout(crossfadeSendTimer);
  crossfadeSendTimer = setTimeout(() => {
    cmd("mixer.crossfade", { position: value }).catch((err) => {
      setStatusError(err);
      logLine("mixer.crossfade.error", err instanceof Error ? err.message : String(err), true);
    });
  }, 40);
});

// -- boot ---------------------------------------------------------------

connectWs();
pollStatus();
pollLibrary();
setInterval(pollStatus, STATUS_POLL_MS);
setInterval(pollLibrary, LIBRARY_POLL_MS);
