// In-app learning player. Plays the downloaded file when present (Capacitor's
// local server → range requests → seeking works), else streams from the sync
// server. Subtitles are a custom overlay driven by the tokenized transcript —
// the same token markup + tap store as the prep doc, so marking a word here
// is the same act as marking it there — with a plain-SRT fallback when no
// transcript is available. Prep-doc keywords glow orange in the subs; tapping
// one pops its gloss + curate notes. Subtitle modes: on / keyword-only (subs
// stay hidden unless the line carries a keyword or a ★-marked word) / off.
// Custom controls (replay line / prev / next line, speed, furigana,
// fullscreen), resume position, wake lock while playing.

import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { api } from "../api";
import { rubyWord, segsNode, tokenSpan } from "../prep-render";
import { cachePrep, cycleTap, getCachedPrep, getTaps } from "../store";
import {
  clearPosition,
  getPosition,
  getVideoRecord,
  loadLocalDefinitions,
  loadLocalTranscript,
  playVideo,
  savePosition,
} from "../video";
import type { Definitions, GlossEntry, PrepDoc, Segs, TapMark, Token } from "../types";

/** One subtitle cue: tokenized (tappable) or plain text (SRT fallback). */
export interface Cue {
  start: number;
  end: number;
  tokens?: Token[];
  text?: string;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const SRT_TIME = /(\d+):(\d\d):(\d\d)[,.](\d{1,3})/g;

/** SRT → plain cues. Lenient: skips malformed blocks rather than throwing. */
export function parseSrt(srt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of srt.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    if (/^\d+$/.test(lines[0])) lines.shift(); // cue number
    const timing = lines.shift();
    if (!timing?.includes("-->")) continue;
    SRT_TIME.lastIndex = 0;
    const t1 = SRT_TIME.exec(timing);
    const t2 = t1 && SRT_TIME.exec(timing);
    if (!t1 || !t2) continue;
    const sec = (m: RegExpExecArray) =>
      +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0") / 1000;
    const text = lines.join("\n").trim();
    if (text) cues.push({ start: sec(t1), end: sec(t2), text });
  }
  return cues;
}

/** Index of the cue covering time t, or -1 (between cues / before the first).
    Cues are sorted by start; binary search, so timeupdate stays cheap. */
export function cueIndexAt(cues: Cue[], t: number): number {
  const i = lastStartedAt(cues, t);
  return i >= 0 && t < cues[i].end ? i : -1;
}

/** Greatest index with start <= t, or -1. The anchor for replay/prev/next. */
export function lastStartedAt(cues: Cue[], t: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** ASR sentence ends cut subtitles off early and leave dead air between
    lines. Let each cue linger until the next one starts (capped), so text
    stays up through natural pauses. Pure; used on load. */
export function extendCues(cues: Cue[], maxLinger = 2.5): Cue[] {
  return cues.map((c, i) => {
    const next = cues[i + 1];
    const end = next ? Math.max(c.end, Math.min(next.start, c.end + maxLinger)) : c.end + maxLinger;
    return { ...c, end };
  });
}

/** Subtitle visibility: always · only lines with a keyword/★ word · never. */
export type SubMode = "on" | "kw" | "off";
const SUB_MODES: SubMode[] = ["on", "kw", "off"];
const SUB_MODE_KEY = "fp.sub.mode"; // a viewing preference, global not per-episode

export function getSubMode(): SubMode {
  const raw = localStorage.getItem(SUB_MODE_KEY);
  return (SUB_MODES as string[]).includes(raw ?? "") ? (raw as SubMode) : "on";
}

function nextSubMode(): SubMode {
  const mode = SUB_MODES[(SUB_MODES.indexOf(getSubMode()) + 1) % SUB_MODES.length];
  localStorage.setItem(SUB_MODE_KEY, mode);
  return mode;
}

/** What the player knows about a noted word: its glossary row + the focal
    point's "why", when the curate pass flagged it. */
export interface KeywordInfo {
  entry: GlossEntry;
  why?: Segs;
}

/** lemma → gloss/notes for the prep doc's *noted* words: glossary rows the
    curate pass actually glossed, plus focal-point words. Uncurated candidate
    rows (empty gloss, nothing to show) stay ordinary tap targets. */
export function keywordIndex(doc: PrepDoc | null): Map<string, KeywordInfo> {
  const map = new Map<string, KeywordInfo>();
  if (!doc) return map;
  for (const g of doc.glossary) {
    if (g.gloss || g.gloss_segs?.length || g.note_segs?.length)
      map.set(g.lemma, { entry: g });
  }
  for (const fp of doc.curate?.focal_points ?? []) {
    const cur = map.get(fp.word);
    if (cur) cur.why = fp.why_segs;
    else map.set(fp.word, { entry: { lemma: fp.word }, why: fp.why_segs });
  }
  return map;
}

/** kw-mode gate: does this line carry a noted keyword or a ★-marked word? */
export function cueTriggered(
  c: Cue,
  keywords: Map<string, KeywordInfo>,
  taps: Record<string, TapMark>,
): boolean {
  return !!c.tokens?.some((t) => t.l && (keywords.has(t.l) || taps[t.l] === "h"));
}

function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** Tokenized cues for the episode: local sidecar → server → null (SRT era). */
async function loadTokenCues(ep: string): Promise<Cue[] | null> {
  const local = await loadLocalTranscript(ep);
  if (local?.sentences?.length) return local.sentences;
  try {
    const doc = await api.getTranscript(ep);
    if (doc.sentences?.length) return doc.sentences;
  } catch {
    /* endpoint missing / unreachable — fall through to SRT */
  }
  return null;
}

/** Plain cues from the SRT sidecar: local file first, then the server. */
async function loadSrtCues(ep: string): Promise<Cue[]> {
  const rec = getVideoRecord(ep);
  if (rec?.subsPath) {
    try {
      const { data } = await Filesystem.readFile({
        path: rec.subsPath,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      return parseSrt(data as string);
    } catch {
      /* fall through to server */
    }
  }
  return parseSrt(await api.fetchSubs(ep));
}

const SPEEDS = [1, 1.25, 1.5, 0.75];

export function playerView(episodeId: string, startAt?: number): HTMLElement {
  const root = el("div", "view player-view");
  const title = getCachedPrep(episodeId)?.episode.title;
  if (title) root.appendChild(el("h1", "", title));

  const stage = el("div", "player-stage");
  const video = el("video") as HTMLVideoElement;
  video.playsInline = true;
  video.preload = "metadata";
  const overlay = el("div", "subs-overlay");
  const pop = el("div", "gloss-pop");
  pop.style.display = "none";
  stage.append(video, overlay, pop);

  // keyword glosses/notes from the prep doc (cache-first; fetch is best-effort
  // — without it keywords just aren't special)
  let keywords = keywordIndex(getCachedPrep(episodeId));
  if (!keywords.size) {
    void api
      .getPrep(episodeId)
      .then((doc) => {
        cachePrep(doc);
        keywords = keywordIndex(doc);
        repaintCue();
      })
      .catch(() => {});
  }

  // per-episode JMdict for the any-word popup: downloaded sidecar first, else
  // one server fetch (best-effort — popups still offer the mark button)
  let defs: Definitions = {};
  void loadLocalDefinitions(episodeId).then(async (local) => {
    if (local) {
      defs = local;
      return;
    }
    try {
      defs = await api.getDefinitions(episodeId);
    } catch {
      /* offline and not downloaded — dictionary unavailable */
    }
  });

  const status = el("div", "status");

  // --- controls ----------------------------------------------------------
  const controls = el("div", "player-controls");
  const seekRow = el("div", "row");
  const scrub = el("input") as HTMLInputElement;
  scrub.type = "range";
  scrub.min = "0";
  scrub.max = "0";
  scrub.step = "0.1";
  const clock = el("span", "muted clock", "0:00 / 0:00");
  seekRow.append(scrub, clock);

  const btnRow = el("div", "row buttons");
  const playBtn = el("button", "pv", "▶") as HTMLButtonElement;
  const replayBtn = el("button", "pv", "⟲") as HTMLButtonElement;
  const prevBtn = el("button", "pv", "⏮") as HTMLButtonElement;
  const nextBtn = el("button", "pv", "⏭") as HTMLButtonElement;
  const speedBtn = el("button", "pv", "1×") as HTMLButtonElement;
  const ccBtn = el("button", "pv", "cc") as HTMLButtonElement;
  const rubyBtn = el("button", "pv on", "あ") as HTMLButtonElement;
  const fsBtn = el("button", "pv", "⛶") as HTMLButtonElement;
  btnRow.append(replayBtn, prevBtn, playBtn, nextBtn, speedBtn, ccBtn, rubyBtn, fsBtn);
  controls.append(seekRow, btnRow);

  // --- footer ------------------------------------------------------------
  const footer = el("div", "btnrow");
  const prepLink = el("a", "btn small", "open prep doc") as HTMLAnchorElement;
  prepLink.href = `#/prep/${encodeURIComponent(episodeId)}`;
  footer.appendChild(prepLink);
  if (getVideoRecord(episodeId)) {
    const vlc = el("button", "small", "VLC") as HTMLButtonElement;
    vlc.addEventListener("click", () => {
      video.pause();
      void playVideo(episodeId, title).catch(
        (e) => (status.textContent = `⚠ ${(e as Error).message}`),
      );
    });
    footer.appendChild(vlc);
  }

  root.append(stage, controls, status, footer);

  // --- subtitles ---------------------------------------------------------
  let cues: Cue[] = [];
  let current = -2; // ≠ -1 so the first timeupdate paints even in a gap

  const paintTaps = () => {
    const taps = getTaps(episodeId);
    overlay.querySelectorAll<HTMLElement>(".w[data-lemma]").forEach((w) => {
      const mark = taps[w.dataset.lemma!];
      w.classList.toggle("tap-k", mark === "k");
      w.classList.toggle("tap-h", mark === "h");
    });
  };

  const showCue = (i: number) => {
    current = i;
    overlay.textContent = "";
    if (i < 0) return;
    const c = cues[i];
    const mode = getSubMode();
    if (mode === "off") return;
    if (mode === "kw" && !cueTriggered(c, keywords, getTaps(episodeId))) return;
    if (c.tokens) {
      for (const t of c.tokens) {
        const n = tokenSpan(t, null);
        if (t.l && keywords.has(t.l) && n instanceof HTMLElement) n.classList.add("kw");
        overlay.appendChild(n);
      }
      paintTaps();
    } else if (c.text) {
      overlay.textContent = c.text;
    }
  };
  const repaintCue = () => showCue(cueIndexAt(cues, video.currentTime));

  // --- any-word popup: curated gloss/notes on top, JMdict senses below,
  // with the mark cycle inside (marks land in the shared tap store) ---------
  const hidePop = () => (pop.style.display = "none");
  const markLabel = (m: TapMark | undefined) =>
    m === "k" ? "known ✓" : m === "h" ? "interest ★" : "mark";
  const showPopup = (lemma: string) => {
    const info = keywords.get(lemma);
    const entries = defs[lemma] ?? [];
    pop.textContent = "";
    const head = el("div", "gp-head");
    head.appendChild(rubyWord(lemma, info?.entry.reading ?? entries[0]?.r[0]));
    const mark = el("button", "gp-mark", markLabel(getTaps(episodeId)[lemma])) as HTMLButtonElement;
    mark.addEventListener("click", (e) => {
      e.stopPropagation();
      mark.textContent = markLabel(cycleTap(episodeId, lemma));
      paintTaps();
    });
    head.appendChild(mark);
    pop.appendChild(head);
    // the curate pass's own gloss/note/why lead — they're episode-specific
    if (info?.entry.gloss) pop.appendChild(el("div", "gp-gloss", info.entry.gloss));
    if (info?.entry.note_segs?.length) {
      const note = el("div", "gp-note");
      note.appendChild(segsNode(info.entry.note_segs));
      pop.appendChild(note);
    }
    if (info?.why?.length) {
      const why = el("div", "gp-why");
      why.appendChild(segsNode(info.why));
      pop.appendChild(why);
    }
    // dictionary senses (capped — this is a glance, not a dictionary page)
    for (const entry of entries.slice(0, 2)) {
      const d = el("div", "gp-dict");
      // header already shows the first entry's reading
      if (entry !== entries[0]) d.appendChild(el("span", "gp-reading", entry.r[0] ?? ""));
      for (const sense of entry.s.slice(0, 3)) {
        const line = el("div", "gp-sense");
        if (sense.pos.length) line.appendChild(el("span", "gp-pos", sense.pos[0]));
        line.appendChild(document.createTextNode(sense.g.slice(0, 4).join("; ")));
        d.appendChild(line);
      }
      pop.appendChild(d);
    }
    if (!info && !entries.length)
      pop.appendChild(el("div", "gp-none", "no dictionary entry"));
    pop.style.display = "";
  };
  pop.addEventListener("click", (e) => e.stopPropagation()); // reading ≠ pause

  // tap any word → definition popup (marking moved inside it, so the popup
  // is the one gesture for both looking up and marking)
  overlay.addEventListener("click", (e) => {
    const w = (e.target as HTMLElement).closest<HTMLElement>(".w[data-lemma]");
    if (!w) return;
    e.stopPropagation(); // don't fall through to the stage's play/pause toggle
    showPopup(w.dataset.lemma!);
  });

  void (async () => {
    try {
      const tokenized = await loadTokenCues(episodeId);
      cues = extendCues(tokenized ?? (await loadSrtCues(episodeId)));
      if (!tokenized) status.textContent = "plain subs (no tokenized transcript) — taps unavailable";
      repaintCue();
    } catch (e) {
      status.textContent = `subs unavailable: ${(e as Error).message}`;
    }
  })();

  // --- source: local file when downloaded, else stream --------------------
  void (async () => {
    const rec = getVideoRecord(episodeId);
    if (rec) {
      try {
        const { uri } = await Filesystem.getUri({ path: rec.path, directory: Directory.Data });
        video.src = Capacitor.convertFileSrc(uri);
        return;
      } catch {
        /* record without file — fall back to streaming */
      }
    }
    try {
      video.src = api.videoUrl(episodeId);
    } catch (e) {
      status.textContent = `⚠ ${(e as Error).message}`; // no server configured
    }
  })();

  video.addEventListener("error", () => {
    status.textContent = getVideoRecord(episodeId)
      ? "⚠ playback failed — try the VLC button"
      : "⚠ playback failed — server unreachable and no local copy (⬇ video on the queue screen)";
  });

  // --- position: deep-link > saved; save throttled, clear near the end ----
  video.addEventListener("loadedmetadata", () => {
    scrub.max = String(video.duration || 0);
    const t = startAt != null && Number.isFinite(startAt) ? startAt : getPosition(episodeId);
    if (t != null && t > 0 && t < video.duration - 5) video.currentTime = t;
    updateClock();
  });

  let lastSaved = 0;
  const savePos = () => {
    if (!video.duration) return;
    // finished (or nearly): restart from the top next time
    if (video.currentTime > video.duration - 10) clearPosition(episodeId);
    else savePosition(episodeId, video.currentTime);
  };

  const updateClock = () => {
    clock.textContent = `${fmtClock(video.currentTime)} / ${fmtClock(video.duration)}`;
  };

  let scrubbing = false;
  video.addEventListener("timeupdate", () => {
    const i = cueIndexAt(cues, video.currentTime);
    if (i !== current) showCue(i);
    if (!scrubbing) scrub.value = String(video.currentTime);
    updateClock();
    if (Math.abs(video.currentTime - lastSaved) > 5) {
      lastSaved = video.currentTime;
      savePos();
    }
  });

  scrub.addEventListener("pointerdown", () => (scrubbing = true));
  scrub.addEventListener("input", () => {
    video.currentTime = Number(scrub.value);
  });
  scrub.addEventListener("change", () => (scrubbing = false));

  // --- transport ----------------------------------------------------------
  const togglePlay = () => {
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };
  playBtn.addEventListener("click", togglePlay);
  stage.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".w")) return; // word tap, not pause
    if (pop.style.display !== "none") {
      hidePop(); // first tap-away just closes the popup
      return;
    }
    togglePlay();
  });
  video.addEventListener("play", () => (playBtn.textContent = "⏸"));
  video.addEventListener("pause", () => {
    playBtn.textContent = "▶";
    savePos();
  });

  // replay/prev/next anchor on the last cue that *started* (works in gaps too)
  const seekCue = (offset: number) => {
    if (!cues.length) return;
    const anchor = lastStartedAt(cues, video.currentTime);
    const i = Math.max(0, Math.min(cues.length - 1, (anchor < 0 ? 0 : anchor) + offset));
    video.currentTime = cues[i].start;
    showCue(cueIndexAt(cues, video.currentTime));
  };
  replayBtn.addEventListener("click", () => seekCue(0));
  prevBtn.addEventListener("click", () => seekCue(-1));
  nextBtn.addEventListener("click", () => seekCue(+1));

  let speedIdx = 0;
  speedBtn.addEventListener("click", () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    video.playbackRate = SPEEDS[speedIdx];
    speedBtn.textContent = `${SPEEDS[speedIdx]}×`;
  });

  const ccLabel = (m: SubMode) => (m === "on" ? "cc" : m === "kw" ? "cc:kw" : "cc:off");
  ccBtn.textContent = ccLabel(getSubMode());
  ccBtn.classList.toggle("on", getSubMode() !== "off");
  ccBtn.addEventListener("click", () => {
    const mode = nextSubMode();
    ccBtn.textContent = ccLabel(mode);
    ccBtn.classList.toggle("on", mode !== "off");
    repaintCue();
  });

  rubyBtn.addEventListener("click", () => {
    const off = root.classList.toggle("no-ruby");
    rubyBtn.classList.toggle("on", !off);
  });

  fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void root.requestFullscreen().then(
        // best-effort: not all webviews allow orientation lock
        () => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })
          .lock?.("landscape").catch(() => {}),
        () => {},
      );
    }
  });

  // --- wake lock while playing --------------------------------------------
  type WakeSentinel = { release(): Promise<void> } | null;
  let wake: WakeSentinel = null;
  const acquireWake = async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> };
      };
      wake = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {
      wake = null; // unsupported / denied — the video itself may hold the screen
    }
  };
  const releaseWake = () => {
    void wake?.release().catch(() => {});
    wake = null;
  };
  video.addEventListener("play", () => void acquireWake());
  video.addEventListener("pause", releaseWake);
  const onVisibility = () => {
    if (document.hidden) savePos();
    else if (!video.paused) void acquireWake(); // the lock drops when backgrounded
  };
  document.addEventListener("visibilitychange", onVisibility);

  // --- teardown: a detached <video> keeps playing, so stop it on route-away
  const cleanup = () => {
    savePos();
    video.pause();
    video.removeAttribute("src");
    video.load();
    releaseWake();
    document.removeEventListener("visibilitychange", onVisibility);
  };
  window.addEventListener("hashchange", cleanup, { once: true });

  return root;
}
