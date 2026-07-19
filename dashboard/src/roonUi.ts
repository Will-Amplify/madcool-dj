import type { Api } from "./api";
import type { RoonZone } from "./types";
import { fmt, setBadge } from "./dom";

export type RoonUiDeps = {
  cmd: Api["cmd"];
  log: (line: string) => void;
  flash: (msg: string) => void;
  roonBadge: HTMLDivElement;
  roonList: HTMLUListElement;
  roonHint: HTMLParagraphElement;
};

export function createRoonUi(deps: RoonUiDeps) {
  const { cmd, log, flash, roonBadge, roonList, roonHint } = deps;
  const roonScrubbing = new Set<string>();
  const roonVolChanging = new Set<string>();

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
  const titleRow = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = z.displayName;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = ` ${z.state}${z.queueItemsRemaining ? ` · ${z.queueItemsRemaining} queued` : ""}`;
  titleRow.append(strong, meta);
  head.appendChild(titleRow);

  const nowPlaying = document.createElement("div");
  nowPlaying.className = "zone-now";
  const np = z.nowPlaying;
  if (np) {
    const line1 = document.createElement("strong");
    line1.textContent = np.line1 || "";
    const line2 = document.createElement("div");
    line2.className = "meta";
    line2.textContent = `${np.line2 || ""}${np.line3 ? ` · ${np.line3}` : ""}`;
    nowPlaying.append(line1, line2);
  } else {
    nowPlaying.classList.add("meta");
    nowPlaying.textContent = "Nothing playing";
  }
  head.appendChild(nowPlaying);
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
    // Don't wipe the list mid-scrub — seek/volume pointer capture dies otherwise.
    if (roonScrubbing.size > 0 || roonVolChanging.size > 0) return;
    roonList.innerHTML = "";
    for (const z of zones) {
      roonList.appendChild(renderZoneCard(z));
    }
  } catch (e) {
    setBadge(roonBadge, false, true);
    roonHint.textContent = String(e);
    if (roonScrubbing.size === 0 && roonVolChanging.size === 0) {
      roonList.innerHTML = "";
    }
  }
}

  return { refreshRoon };
}
