import "./style.css";

import { createApi } from "./api";
import {
  BROWSE_PATH_KEY,
  LOAD_DECK_KEY,
  MUSIC_ROOT,
  TOKEN_KEY,
  byId,
  fmt,
  isTypingTarget,
  matchesFilter,
  setBadge,
} from "./dom";
import { mountMusicGen, useReferencePath } from "./musicGen";
import { createRoonUi } from "./roonUi";
import { mountStudio } from "./studio";
import type {
  BrowseDir,
  BrowseFile,
  BrowseResult,
  CmdResponse,
  DeckName,
  DeckSummary,
  LevelsEvent,
  LibraryTrack,
  LoadResult,
  PlanEvent,
  StatusResult,
  TrackAnalysis,
} from "./types";
import { drawWave, renderBands } from "./wave";

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

function musicRoot(): string {
  return localStorage.getItem("madcool-dj.musicRoot") || MUSIC_ROOT;
}

function token(): string {
  return tokenInput.value.trim();
}

const { cmd, getStatus, authHeaders, apiBase } = createApi(token);

function log(line: string): void {
  const ts = new Date().toLocaleTimeString();
  logBody.textContent = `[${ts}] ${line}\n` + (logBody.textContent || "");
  const lines = (logBody.textContent || "").split("\n");
  if (lines.length > 200) logBody.textContent = lines.slice(0, 200).join("\n");
}


function flash(msg: string): void {
  transportStatus.textContent = msg;
}

const { refreshRoon } = createRoonUi({
  cmd, log, flash, roonBadge, roonList, roonHint,
});

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
  const rateEl = byId<HTMLInputElement>(`deck-${deck}-rate`);
  if (document.activeElement !== rateEl) rateEl.value = String(rate);
  const gainEl = byId<HTMLInputElement>(`deck-${deck}-gain`);
  if (document.activeElement !== gainEl && d.gain != null) gainEl.value = String(d.gain);
  for (const band of ["low", "mid", "high"] as const) {
    const eqEl = byId<HTMLInputElement>(`deck-${deck}-eq-${band}`);
    if (document.activeElement !== eqEl && d.eq?.[band] != null) eqEl.value = String(d.eq[band]);
  }
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

function wireFileRow(li: HTMLLIElement, path: string, label: string, title?: string): void {
  const indexed = library.find((t) => t.path === path);
  const bpm = indexed?.analysis?.bpm ? `${indexed.analysis.bpm.toFixed(0)} bpm` : "";
  li.draggable = true;
  const nameSpan = document.createElement("span");
  nameSpan.textContent = label;
  const metaSpan = document.createElement("span");
  metaSpan.className = "meta";
  metaSpan.textContent = bpm;
  li.replaceChildren(nameSpan, metaSpan);
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
    const nameSpan = document.createElement("span");
    nameSpan.textContent = `📁 ${dir.name}`;
    const metaSpan = document.createElement("span");
    metaSpan.className = "meta";
    metaSpan.textContent = "dir";
    li.replaceChildren(nameSpan, metaSpan);
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
    const st = await getStatus();
    const fixtureRoot = st.fixtures_root || "/home/madcoolseed/Projects/madcool-dj/fixtures/clips";
    const scan = await cmd<{ root: string; count: number }>("library.scan", { root: fixtureRoot });
    const listed = await cmd<{ tracks: LibraryTrack[] }>("library.list");
    library = listed.tracks || [];
    analysisByPath = new Map(library.filter((t) => t.path).map((t) => [t.path, t.analysis]));
    const clips = library.filter((t) => /clip_[ab]\.wav$/i.test(t.path));
    const a = clips.find((t) => /clip_a/i.test(t.path)) || clips[0];
    const b = clips.find((t) => /clip_b/i.test(t.path)) || clips[1];
    if (!a && !b) {
      flash(`No fixtures in ${scan.root} — run ./scripts/make-fixtures.sh`);
      return;
    }
    if (a) await loadOntoDeck("a", a.path, a.title || "clip_a");
    if (b) await loadOntoDeck("b", b.path, b.title || "clip_b");
    await browseTo(scan.root).catch(() => undefined);
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
const persistToken = () => {
  localStorage.setItem(TOKEN_KEY, tokenInput.value);
  reconnectWs();
};
tokenInput.onchange = persistToken;
tokenInput.onblur = persistToken;

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
    if (st.plan) renderPlan(st.plan);
    if (st.levels) applyLevels(st.levels);
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

let liveWs: WebSocket | null = null;
let wsReconnectTimer: number | null = null;
let wsGeneration = 0;

function reconnectWs(): void {
  wsGeneration += 1;
  if (wsReconnectTimer != null) {
    window.clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  try {
    liveWs?.close();
  } catch {
    /* ignore */
  }
  liveWs = null;
  connectWs();
}

function connectWs(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const t = token();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  if (liveWs && (liveWs.readyState === WebSocket.OPEN || liveWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const gen = wsGeneration;
  const ws = new WebSocket(`${proto}://${location.host}/v1/live${q}`);
  liveWs = ws;
  ws.onopen = () => {
    if (gen !== wsGeneration) return;
    setBadge(connBadge, true);
  };
  ws.onclose = () => {
    if (liveWs === ws) liveWs = null;
    if (gen !== wsGeneration) return;
    setBadge(connBadge, false);
    if (wsReconnectTimer == null) {
      wsReconnectTimer = window.setTimeout(() => {
        wsReconnectTimer = null;
        connectWs();
      }, 1500);
    }
  };
  ws.onerror = () => {
    if (gen !== wsGeneration) return;
    setBadge(connBadge, false, true);
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.event === "plan") {
        renderPlan(msg.data);
      }
      if (msg.event === "levels" && msg.data) {
        applyLevels(msg.data as LevelsEvent);
      }
      if (msg.event === "log" && msg.data?.msg) {
        log(String(msg.data.msg));
      } else if (msg.event) {
        log(`${msg.event} ${JSON.stringify(msg.data ?? {})}`.slice(0, 180));
      }
    } catch {
      /* ignore */
    }
  };
}

function setVu(id: string, value: number | undefined): void {
  const el = document.getElementById(id);
  if (!el) return;
  const pct = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
  (el as HTMLElement).style.width = `${pct}%`;
}

function applyLevels(data: LevelsEvent): void {
  setVu("vu-l", data.peak_l);
  setVu("vu-r", data.peak_r);
  setVu("vu-a", data.deck_a);
  setVu("vu-b", data.deck_b);
  if (typeof data.crossfade === "number" && document.activeElement !== crossfader) {
    crossfader.value = String(data.crossfade);
    crossfaderValue.textContent = data.crossfade.toFixed(2);
  }
}

function renderPlan(data: PlanEvent | null | undefined): void {
  planBody.replaceChildren();
  if (!data || data.cancelled) {
    const p = document.createElement("p");
    p.className = "plan-empty";
    p.textContent = data?.cancelled ? "Plan cancelled (manual override)." : "No transition planned yet.";
    planBody.appendChild(p);
    return;
  }
  if (data.reason === "no_candidate") {
    const p = document.createElement("p");
    p.className = "plan-empty";
    p.textContent = `No candidate within BPM window · ${data.remaining_sec ?? "?"}s left on ${String(data.from || "?").toUpperCase()}`;
    planBody.appendChild(p);
    return;
  }
  const card = document.createElement("div");
  card.className = "plan-card";
  const head = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = `${String(data.from || "?").toUpperCase()} → ${String(data.to || "?").toUpperCase()}`;
  head.appendChild(strong);
  card.appendChild(head);
  if (data.path) {
    const pathEl = document.createElement("div");
    pathEl.className = "plan-path";
    pathEl.textContent = data.path.split("/").slice(-2).join("/");
    card.appendChild(pathEl);
  }
  const meta = document.createElement("div");
  const bits = [
    data.bpm != null ? `${Number(data.bpm).toFixed(1)} bpm` : null,
    data.rate != null && data.rate !== 1 ? `rate ${((data.rate - 1) * 100).toFixed(1)}%` : null,
    data.cue_sec != null ? `cue ${fmt(data.cue_sec)}` : null,
    data.ramp_sec != null ? `ramp ${data.ramp_sec}s` : null,
    data.remaining_sec != null ? `${data.remaining_sec}s left` : null,
  ].filter(Boolean);
  meta.textContent = bits.join(" · ");
  card.appendChild(meta);
  planBody.appendChild(card);
}

let focusedDeck: DeckName = "a";

window.addEventListener("keydown", (ev) => {
  if (isTypingTarget(ev.target)) return;
  const key = ev.key.toLowerCase();
  if (key === "a") {
    focusedDeck = "a";
    flash("Focus: deck A");
    return;
  }
  if (key === "b") {
    focusedDeck = "b";
    flash("Focus: deck B");
    return;
  }
  if (key === " " || key === "enter") {
    ev.preventDefault();
    const playing = lastStatus?.decks[focusedDeck]?.playing;
    void cmd(playing ? "deck.pause" : "deck.play", { deck: focusedDeck }).catch((e) => flash(String(e)));
    return;
  }
  if (key === "arrowleft" || key === "arrowright") {
    ev.preventDefault();
    const cur = Number(crossfader.value);
    const next = Math.max(0, Math.min(1, cur + (key === "arrowright" ? 0.05 : -0.05)));
    crossfader.value = String(next);
    crossfaderValue.textContent = next.toFixed(2);
    void cmd("mixer.crossfade", { position: next }).catch((e) => flash(String(e)));
    return;
  }
  if (key === "q") {
    void cmd("deck.cue", { deck: focusedDeck }).catch((e) => flash(String(e)));
  }
});

connectWs();
void poll();
window.setInterval(() => void poll(), 500);
void browseTo(browsePath).catch(() => undefined);
void refreshRoon();
window.setInterval(() => void refreshRoon(), 8000);
log("dashboard ready · keys: A/B focus · Space play · ←/→ crossfade · Q cue");

mountStudio({ cmd, log, flash });
mountMusicGen({
  cmd, authHeaders, log, flash, loadOntoDeck,
  getLoadTarget: () => loadTarget,
});

