/**
 * Prompt composer for MiniMax Music 3.0.
 * Official guidance: vivid English sentences (creative brief), not tag soup.
 * BPM/key land as explicit phrases — model matches them reliably when stated.
 */

export interface MusicGenSettings {
  bpm?: number | null;
  key?: string | null;
  genre?: string | null;
  subgenre?: string | null;
  moods?: string[];
  complexity?: "sparse" | "balanced" | "dense" | "maximal";
  energy?: "low" | "medium" | "high" | "peak";
  vocals?: "none" | "male" | "female" | "duet" | "choir" | "rap" | "sing-rap";
  vocalStyle?: string | null;
  instruments?: string[];
  atmosphere?: string | null;
  theme?: string | null;
  avoid?: string | null;
  useCase?: string | null;
  era?: string | null;
  /** Extra freeform that gets woven in */
  extras?: string | null;
  /** Reference track metadata to imitate */
  reference?: {
    title?: string | null;
    artist?: string | null;
    genre?: string | null;
    bpm?: number | null;
    duration_sec?: number | null;
    notes?: string | null;
  } | null;
}

const COMPLEXITY_PHRASE: Record<NonNullable<MusicGenSettings["complexity"]>, string> = {
  sparse: "sparse arrangement with deliberate space and minimal layering",
  balanced: "balanced production with clear lead elements and supportive beds",
  dense: "dense layered production with rich midrange detail and stacked parts",
  maximal: "maximalist wall-of-sound production with intricate fills and constant motion",
};

const ENERGY_PHRASE: Record<NonNullable<MusicGenSettings["energy"]>, string> = {
  low: "restrained dynamics and a slow-burning intensity",
  medium: "steady mid-energy groove",
  high: "high-energy drive with punchy transients",
  peak: "peak-time intensity built for drops and crowd release",
};

const VOCAL_PHRASE: Record<Exclude<NonNullable<MusicGenSettings["vocals"]>, "none">, string> = {
  male: "featuring a confident male lead vocal",
  female: "featuring a clear expressive female lead vocal",
  duet: "featuring intertwined male and female duet vocals",
  choir: "featuring layered choir-style backing vocals",
  rap: "featuring rhythmic rap vocals with precise diction",
  "sing-rap": "featuring melodic sing-rap vocals with modern autotune color",
};

function clean(s: string | null | undefined): string {
  return (s || "").trim().replace(/\s+/g, " ");
}

function joinList(items: string[] | undefined, fallback = ""): string {
  const list = (items || []).map((x) => clean(x)).filter(Boolean);
  if (!list.length) return fallback;
  if (list.length === 1) return list[0]!;
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

/** Build the English creative-brief prompt MiniMax responds to best. */
export function composeMusicPrompt(settings: MusicGenSettings): string {
  const moods = joinList(settings.moods, "focused");
  const genreBits = [clean(settings.genre), clean(settings.subgenre)].filter(Boolean).join(" ");
  const genre = genreBits || "electronic";
  const bpm = settings.bpm && settings.bpm > 0 ? `${Math.round(settings.bpm)} BPM ` : "";
  const key = clean(settings.key) ? `${clean(settings.key)}, ` : "";
  const era = clean(settings.era) ? `${clean(settings.era)} ` : "";

  const sentences: string[] = [];

  sentences.push(
    `A ${moods} ${bpm}${era}${genre} track${key ? ` in ${clean(settings.key)}` : ""}.`.replace(
      /\s+/g,
      " ",
    ),
  );

  const vocals = settings.vocals || "none";
  if (vocals === "none") {
    const inst = joinList(settings.instruments, "synth bass, drums, and atmospheric pads");
    sentences.push(`Instrumental with ${inst}.`);
  } else {
    const base = VOCAL_PHRASE[vocals];
    const style = clean(settings.vocalStyle);
    sentences.push(style ? `${base}, ${style}.` : `${base}.`);
    const inst = joinList(settings.instruments);
    if (inst) sentences.push(`Instrumentation centers on ${inst}.`);
  }

  if (clean(settings.theme)) {
    sentences.push(`About ${clean(settings.theme)}.`);
  }
  if (clean(settings.atmosphere)) {
    sentences.push(`Atmosphere: ${clean(settings.atmosphere)}.`);
  }

  const complexity = settings.complexity || "balanced";
  const energy = settings.energy || "medium";
  sentences.push(`Production: ${COMPLEXITY_PHRASE[complexity]}, ${ENERGY_PHRASE[energy]}.`);

  if (clean(settings.useCase)) {
    sentences.push(`Intended for ${clean(settings.useCase)}.`);
  }

  const ref = settings.reference;
  if (ref && (ref.title || ref.artist || ref.genre || ref.bpm)) {
    const who = [clean(ref.artist), clean(ref.title)].filter(Boolean).join(" — ");
    const bits = [
      who ? `echoing the vibe of ${who}` : null,
      ref.genre ? `in a ${clean(ref.genre)} vein` : null,
      ref.bpm ? `near ${Math.round(ref.bpm)} BPM` : null,
      clean(ref.notes),
    ].filter(Boolean);
    sentences.push(
      `Inspired by a reference track${bits.length ? `: ${bits.join(", ")}` : ""}. Capture the feel without copying melodies verbatim.`,
    );
  }

  if (clean(settings.extras)) {
    sentences.push(clean(settings.extras) + (settings.extras!.trim().endsWith(".") ? "" : "."));
  }
  if (clean(settings.avoid)) {
    sentences.push(`Avoid ${clean(settings.avoid)}.`);
  }

  let prompt = sentences.join(" ").replace(/\s+/g, " ").trim();
  if (prompt.length > 2000) prompt = prompt.slice(0, 1997) + "...";
  return prompt;
}

/** Cover-model prompt is shorter (10–300 chars). */
export function composeCoverPrompt(settings: MusicGenSettings): string {
  const moods = joinList(settings.moods, "fresh");
  const genre = [clean(settings.genre), clean(settings.subgenre)].filter(Boolean).join(" ") || "electronic";
  const bpm = settings.bpm ? `${Math.round(settings.bpm)} BPM` : "";
  const parts = [genre, moods, bpm, clean(settings.atmosphere), joinList(settings.instruments)]
    .filter(Boolean)
    .join(", ");
  let p = parts || "Modern reinterpretation, polished mix";
  if (p.length < 10) p = `${p}, studio quality`;
  if (p.length > 300) p = p.slice(0, 297) + "...";
  return p;
}

export function defaultLyricsScaffold(theme: string, structure: "short" | "radio" | "full" = "radio"): string {
  const t = clean(theme) || "midnight signal cutting through the noise";
  if (structure === "short") {
    return `[Intro]\n(soft pads)\n\n[Verse]\n${t}\nfinding patterns in the dark\n\n[Chorus]\nCool the data, raise the gain\nlet the signal cut the rain\n\n[Outro]\n(fade)`;
  }
  if (structure === "full") {
    return `[Intro]\n(atmosphere builds)\n\n[Verse]\n${t}\nsteps on the floor, heart in time\n\n[Pre Chorus]\nhold the breath, wait for the drop\n\n[Chorus]\nCool the data, raise the gain\nlet the signal cut the rain\nwe were built for this refrain\n\n[Verse]\nshadows move where basslines land\ncode and blood in either hand\n\n[Bridge]\n(breakdown)\nstrip it back to pure tone\n\n[Build Up]\n(risers)\n\n[Chorus]\nCool the data, raise the gain\nlet the signal cut the rain\n\n[Outro]\n(echoes dissolve)`;
  }
  return `[Intro]\n(pulse)\n\n[Verse]\n${t}\nlooking for the perfect line\n\n[Pre Chorus]\ncloser now\n\n[Chorus]\nCool the data, raise the gain\nlet the signal cut the rain\n\n[Verse]\nanother pass, another try\n\n[Chorus]\nCool the data, raise the gain\nlet the signal cut the rain\n\n[Outro]\n(soft close)`;
}

export function parseFilenameMeta(filename: string): { title?: string; artist?: string } {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0]!.trim(), title: parts.slice(1).join(" - ").trim() };
  }
  return { title: base };
}

export function guessGenreFromAnalysis(bpm: number | null | undefined, bands?: Record<string, number> | null): string {
  const b = bpm || 120;
  const bass = bands?.bass ?? bands?.sub ?? 0.3;
  const hats = bands?.hats ?? bands?.high_mid ?? 0.3;
  if (b >= 165 && b <= 180) return "Drum and Bass";
  if (b >= 135 && b <= 150 && bass > 0.35) return "Dubstep";
  if (b >= 120 && b <= 135) return hats > 0.4 ? "Techno" : "House";
  if (b >= 85 && b <= 100) return "Hip-Hop";
  if (b >= 70 && b <= 85) return "R&B";
  if (b < 70) return "Ambient";
  return "Electronic";
}
