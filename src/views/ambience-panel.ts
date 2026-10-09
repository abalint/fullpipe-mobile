// The ambience sheet: what's playing under your reading, and the controls
// for it — every sound as a row you switch on and set a level for (layer as
// many as you like), the moods as chips (one music channel, shuffled), a
// master pause and a stop. Opens over anything (the manga reader included)
// from the ♫ button; the ♫ lights up while the mix is on. Nothing here
// needs the server once the files are on the phone — a sound or mood is
// pulled the first time it's switched on and stays.

import {
  Ambience,
  describeMix,
  getCatalog,
  getMix,
  isLocal,
  layerOff,
  layerOn,
  layerVolume,
  localBytes,
  mixIsEmpty,
  moodLocal,
  moodOff,
  moodOn,
  musicVolume,
  refreshCatalog,
  resumeMix,
  stopAll,
  verifyLocal,
} from "../ambience";
import type { AmbienceCatalog, AmbienceMood, AmbienceSound, AmbienceState } from "../ambience";

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const fmtMb = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 10e6 ? 1 : 0)} MB`;
const fmtHours = (ms: number) => (ms >= 3.6e6 ? `${(ms / 3.6e6).toFixed(1)} h` : `${Math.round(ms / 60000)} min`);

const IDLE: AmbienceState = { running: false, paused: false, layers: [] };

// one shared view of the service's state for every ♫ button and strip
let state: AmbienceState = IDLE;
const watchers = new Set<(s: AmbienceState) => void>();
function broadcast(s: AmbienceState): void {
  state = s;
  for (const w of watchers) w(s);
}
void Ambience.addListener("state", broadcast).catch(() => {});
void Ambience.getState().then(broadcast).catch(() => {});

export function ambienceState(): AmbienceState {
  return state;
}

/** Volume slider with the service as its source of truth. */
function slider(value: number, onInput: (v: number) => void): HTMLInputElement {
  const s = document.createElement("input");
  s.type = "range";
  s.min = "0";
  s.max = "100";
  s.step = "1";
  s.className = "amb-vol";
  s.value = String(Math.round(value * 100));
  let timer: number | undefined;
  s.addEventListener("input", () => {
    // the native call per pixel is cheap but chatty; coalesce to ~30 Hz
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      onInput(Number(s.value) / 100);
    }, 33);
  });
  s.addEventListener("change", () => onInput(Number(s.value) / 100));
  return s;
}

let openSheet: HTMLElement | null = null;

export function openAmbiencePanel(): void {
  if (openSheet) return;
  const backdrop = el("div", "amb-backdrop");
  const sheet = el("div", "amb-sheet");
  backdrop.appendChild(sheet);
  openSheet = backdrop;

  // --- header -------------------------------------------------------------------------
  const head = el("div", "amb-head");
  const title = el("b", "", "Ambience");
  const now = el("span", "amb-now");
  const pauseBtn = el("button", "small", "⏸") as HTMLButtonElement;
  const stopBtn = el("button", "small", "■") as HTMLButtonElement;
  stopBtn.title = "stop everything (the mix is remembered)";
  const closeBtn = el("button", "small", "✕") as HTMLButtonElement;
  head.append(title, now, pauseBtn, stopBtn, closeBtn);
  const status = el("div", "amb-status");
  const resumeBtn = el("button", "primary amb-resume") as HTMLButtonElement;
  resumeBtn.hidden = true;
  const soundsH = el("h3", "", "Sounds");
  const rows = el("div", "amb-rows");
  const musicH = el("h3", "", "Music");
  const moods = el("div", "amb-moods");
  const music = el("div", "amb-music");
  const track = el("div", "amb-track");
  const prevBtn = el("button", "small", "⏮") as HTMLButtonElement;
  const nextBtn = el("button", "small", "⏭") as HTMLButtonElement;
  const musicVol = slider(getMix().musicVolume, (v) => void musicVolume(v).catch(fail));
  const musicRow = el("div", "amb-musicrow");
  musicRow.append(prevBtn, nextBtn, musicVol);
  music.append(track, musicRow);
  const foot = el("div", "amb-foot");
  const syncBtn = el("button", "small", "↻ sync library") as HTMLButtonElement;
  const onPhone = el("span", "muted");
  foot.append(syncBtn, onPhone);
  sheet.append(head, status, resumeBtn, soundsH, rows, musicH, moods, music, foot);

  let cat: AmbienceCatalog | null = getCatalog();
  const busy = new Map<string, string>(); // id → progress text while pulling

  const fail = (e: unknown) => {
    status.textContent = `⚠ ${(e as Error).message}`;
  };

  // --- paint --------------------------------------------------------------------------
  const soundRow = (s: AmbienceSound): HTMLElement => {
    const row = el("div", "amb-row");
    const on = state.layers.some((l) => l.id === s.id);
    row.classList.toggle("on", on);
    const toggle = el("button", "amb-toggle") as HTMLButtonElement;
    toggle.append(el("span", "amb-emoji", s.emoji), el("span", "amb-name", s.title));
    const sub = busy.get(s.id) ?? (isLocal(s.file) ? fmtHours(s.ms) : `⬇ ${fmtMb(s.bytes)}`);
    toggle.appendChild(el("small", "amb-sub", sub));
    toggle.addEventListener("click", () => {
      if (on) {
        void layerOff(s.id).catch(fail);
        return;
      }
      if (!isLocal(s.file)) {
        busy.set(s.id, "⬇ downloading…");
        paint();
      }
      void layerOn(s)
        .catch(fail)
        .finally(() => {
          busy.delete(s.id);
          paint();
        });
    });
    row.appendChild(toggle);
    if (on) {
      const v = state.layers.find((l) => l.id === s.id)?.volume ?? getMix().layers[s.id] ?? 0.5;
      row.appendChild(slider(v, (nv) => void layerVolume(s.id, nv).catch(fail)));
    }
    return row;
  };

  const moodChip = (m: AmbienceMood): HTMLElement => {
    const chip = el("button", "amb-mood") as HTMLButtonElement;
    const cur = getMix().mood === m.id && !!state.music;
    chip.classList.toggle("on", cur);
    const loc = moodLocal(m);
    const sub = busy.get(m.id)
      ?? (loc.all ? `${m.tracks.length} · ${fmtHours(m.tracks.reduce((a, t) => a + t.ms, 0))}`
        : loc.some ? `${loc.done}/${m.tracks.length} on phone`
          : `⬇ ${fmtMb(m.tracks.reduce((a, t) => a + t.bytes, 0))}`);
    chip.append(el("span", "amb-emoji", m.emoji), el("span", "amb-name", m.title), el("small", "amb-sub", sub));
    chip.disabled = m.tracks.length === 0;
    chip.addEventListener("click", () => {
      if (cur) {
        void moodOff().catch(fail);
        return;
      }
      busy.set(m.id, loc.all ? "starting…" : "⬇ …");
      paint();
      void moodOn(m, (done, total) => {
        busy.set(m.id, done < total ? `⬇ ${done}/${total}` : `${total} tracks`);
        paint();
      })
        .catch(fail)
        .finally(() => {
          busy.delete(m.id);
          paint();
        });
    });
    return chip;
  };

  const paint = () => {
    const mix = getMix();
    now.textContent = state.running ? describeMix(mix, cat) : "";
    pauseBtn.textContent = state.paused ? "▶" : "⏸";
    pauseBtn.hidden = !state.running;
    stopBtn.hidden = !state.running;
    resumeBtn.hidden = state.running || mixIsEmpty(mix) || !cat;
    resumeBtn.textContent = `▶ ${describeMix(mix, cat) || "resume"}`;
    rows.textContent = "";
    moods.textContent = "";
    if (!cat || (!cat.sounds.length && !cat.moods.length)) {
      rows.appendChild(el("div", "muted", "no library yet — build one on the PC with /ambience, then sync"));
      musicH.hidden = true;
      moods.hidden = true;
    } else {
      for (const s of cat.sounds) rows.appendChild(soundRow(s));
      musicH.hidden = !cat.moods.length;
      moods.hidden = !cat.moods.length;
      for (const m of cat.moods) moods.appendChild(moodChip(m));
    }
    music.hidden = !state.music;
    if (state.music) {
      track.textContent = state.music.title;
      prevBtn.disabled = nextBtn.disabled = state.music.count < 2;
      if (document.activeElement !== musicVol) musicVol.value = String(Math.round(state.music.volume * 100));
    }
    onPhone.textContent = `${fmtMb(localBytes())} on phone`;
  };

  // --- wiring -------------------------------------------------------------------------
  pauseBtn.addEventListener("click", () => void (state.paused ? Ambience.resume() : Ambience.pause()).catch(fail));
  stopBtn.addEventListener("click", () => void stopAll().catch(fail));
  prevBtn.addEventListener("click", () => void Ambience.previousTrack().catch(fail));
  nextBtn.addEventListener("click", () => void Ambience.nextTrack().catch(fail));
  resumeBtn.addEventListener("click", () => {
    if (!cat) return;
    status.textContent = "starting…";
    void resumeMix(cat, (d, t) => {
      status.textContent = d < t ? `⬇ music ${d}/${t}` : "";
    })
      .then(() => {
        status.textContent = "";
      })
      .catch(fail);
  });
  const sync = async (quiet: boolean) => {
    if (!quiet) status.textContent = "syncing…";
    try {
      await verifyLocal();
      const fresh = await refreshCatalog();
      if (fresh) cat = fresh;
      if (!quiet) status.textContent = fresh ? "" : "⚠ offline — showing the cached library";
    } catch (e) {
      if (!quiet) fail(e);
    }
    paint();
  };
  syncBtn.addEventListener("click", () => void sync(false));
  const close = () => {
    if (!openSheet) return;
    watchers.delete(paint);
    window.removeEventListener("hashchange", close);
    openSheet.remove();
    openSheet = null;
  };
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  window.addEventListener("hashchange", close);
  watchers.add(paint);

  document.body.appendChild(backdrop);
  paint();
  // a fresh catalog is nice-to-have — the cached one paints first
  void sync(true);
}

/** A ♫ button that lights while the mix is on and opens the sheet. `cls`
    styles it for its host bar (the reader's mg-btn, a tab's small button). */
export function ambienceButton(cls: string): HTMLButtonElement {
  const b = el("button", cls, "♫") as HTMLButtonElement;
  b.title = "ambience — background sound while you read";
  const paint = (s: AmbienceState) => b.classList.toggle("on", s.running && !s.paused);
  paint(state);
  watchers.add(paint);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    openAmbiencePanel();
  });
  return b;
}

/** The one-line strip above the nav while a mix plays outside the reader:
    what's on, pause, stop. Mounted once by main.ts. */
export function ambienceStrip(): HTMLElement {
  const bar = el("div", "ambstrip");
  bar.hidden = true;
  const open = el("button", "amb-open") as HTMLButtonElement;
  const tag = el("b", "", "♫");
  const text = el("span", "amb-text");
  open.append(tag, text);
  open.addEventListener("click", openAmbiencePanel);
  const toggle = el("button", "small", "⏸") as HTMLButtonElement;
  toggle.addEventListener("click", () => void (state.paused ? Ambience.resume() : Ambience.pause()).catch(() => {}));
  const stop = el("button", "small", "■") as HTMLButtonElement;
  stop.addEventListener("click", () => void stopAll().catch(() => {}));
  bar.append(open, toggle, stop);
  const paint = () => {
    const [, view] = location.hash.split("/");
    const show = state.running && view !== "manga";
    bar.hidden = !show;
    if (!show) return;
    text.textContent = describeMix(getMix(), getCatalog()) || "ambience";
    toggle.textContent = state.paused ? "▶" : "⏸";
  };
  watchers.add(paint);
  window.addEventListener("hashchange", paint);
  paint();
  return bar;
}
