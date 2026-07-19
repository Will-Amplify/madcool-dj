export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

export const BAND_KEYS = ["sub", "bass", "low_mid", "high_mid", "hats"] as const;
export const TOKEN_KEY = "madcool-dj.token";
export const LOAD_DECK_KEY = "madcool-dj.loadDeck";
export const BROWSE_PATH_KEY = "madcool-dj.browsePath";
export const MUSIC_ROOT = "/home/madcoolseed/Music";

export function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function setBadge(el: HTMLElement, on: boolean, warn = false): void {
  el.classList.toggle("badge--on", on && !warn);
  el.classList.toggle("badge--warn", warn);
  el.classList.toggle("badge--off", !on && !warn);
}

export function matchesFilter(text: string, q: string): boolean {
  return text.toLowerCase().includes(q);
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
