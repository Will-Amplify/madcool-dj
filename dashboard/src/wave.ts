import type { DeckName } from "./types";
import { BAND_KEYS, byId } from "./dom";

export function drawWave(
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

export function renderBands(deck: DeckName, bands: Record<string, number> | null | undefined): void {
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
