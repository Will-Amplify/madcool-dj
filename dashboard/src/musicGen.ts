import type { Api } from "./api";
import type { DeckName } from "./types";
import { byId } from "./dom";

export type MusicGenDeps = {
  cmd: Api["cmd"];
  authHeaders: Api["authHeaders"];
  log: (line: string) => void;
  flash: (msg: string) => void;
  loadOntoDeck: (deck: DeckName, path: string, title?: string) => Promise<void>;
  getLoadTarget: () => DeckName;
};

type UseRef = (path: string) => Promise<void>;
let _useReferencePath: UseRef | null = null;

/** Shift+right-click from Files list seeds Music Gen after mountMusicGen(). */
export async function useReferencePath(path: string): Promise<void> {
  if (!_useReferencePath) throw new Error("music gen not ready");
  return _useReferencePath(path);
}

export function mountMusicGen(deps: MusicGenDeps): void {
  const { cmd, authHeaders, log, flash, loadOntoDeck, getLoadTarget } = deps;

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

async function seedReference(path: string): Promise<void> {
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
  let failStreak = 0;
  const tick = async () => {
    try {
      const job = await cmd<{
        id: string;
        status: string;
        error?: string;
        result?: { path?: string; duration_ms?: number | null };
      }>("music.job", { id });
      failStreak = 0;
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
      failStreak += 1;
      flash(String(e));
      if (failStreak >= 5) {
        if (genPollTimer) window.clearInterval(genPollTimer);
        genPollTimer = null;
        genJobEl.className = "gen-job is-error";
        genJobEl.textContent = `Poll stopped after errors: ${String(e)}`;
      }
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
        if (j.result?.path) void loadOntoDeck(getLoadTarget(), j.result.path);
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
    void seedReference(path).catch((e) => flash(String(e)));
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
    await seedReference(body.result.path);
  })().catch((e) => flash(String(e)));
};

void refreshMusicStatus();
void previewGenPrompt();
window.setInterval(() => void refreshMusicStatus(), 15000);

  _useReferencePath = seedReference;
}
