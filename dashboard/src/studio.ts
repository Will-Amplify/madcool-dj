import type { Api } from "./api";
import { byId } from "./dom";

export type StudioDeps = {
  cmd: Api["cmd"];
  log: (line: string) => void;
  flash: (msg: string) => void;
};

export function mountStudio(deps: StudioDeps): void {
  const { cmd, log, flash } = deps;

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
}
