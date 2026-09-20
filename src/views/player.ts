// In-app learning player. Plays the downloaded file (Capacitor's local
// server → range requests → seeking works) — episodes must be downloaded
// first. Subtitles are a custom overlay driven by the tokenized transcript —
// the same token markup + tap store as the prep doc, so marking a word here
// is the same act as marking it there — with a plain-SRT fallback when no
// transcript is available. Long sentences roll up broadcast-style: the cue is
// chunked into lines that fit the overlay width and shown through a 2-line
// window — current line at the bottom, previous line dimmed above it. Lines
// advance on real aligned token times (Token.t: ASR words/segments, or cue
// spans for hand-sub episodes); tokens without times (episodes staged before
// alignment existed) fall back to each line's width-proportional share of
// the cue's speech span. Subtitle modes: on / keyword-only (subs stay hidden
// unless the line carries a curated keyword or a ★ word) / off.
// Word highlighting is text-color-only (no backgrounds over video), six
// paints (LIVE_REVIEW.md §6): white = known, blue = think you know, purple =
// high interest ★, green = should know (most frequent unknowns), pink =
// high value in this video (curated keyword — dotted, tap for its gloss —
// or ranked candidate), orange = you don't know this (the i+1 target
// underlined, with a "+1" badge on its line). Tiered — off / focus (the
// global lists + pink + the target) / learn (+ every unknown in orange).
// The three global lists are facts about the user, not this episode, so
// they paint at any tier but off and outrank the episode-local hues. The
// Aa panel holds size / height / tier prefs (global, like the
// cc mode). Custom controls (audio/video toggle, prev / next line, speed,
// furigana, fullscreen), resume position, wake lock while playing. The 🎧
// toggle hands the current position off to the native passive-audio service
// so the episode keeps playing with the screen off, and back again.
// Under the video (2026-09-10 — the prep page is gone, this is the episode's
// only screen): the curated synopsis, the rating, and the close-out actions —
// delete · passive · mint cards. There is no "mark watched": the server flips
// an episode watched from the sittings this player records (viewtime.ts),
// once play time passes its activation fraction.

import { Capacitor } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { api, ApiError } from "../api";
import { PassiveAudio } from "../audio";
import { createGlossPopup } from "../gloss-popup";
import type { KeywordInfo } from "../gloss-popup";
import { NO_CONFIRM } from "../lists";
import {
  getSubTier,
  isIplus1,
  paintWordSpans,
  setSubTier,
  soleUnknown,
  SUB_TIERS,
  tokenHighlight,
} from "../highlight";
import {
  applyPaintKnown,
  fetchPaint,
  getCachedPaint,
  grammarListsFor,
  listsFor,
  lookupListOf,
  NO_GRAMMAR,
  NO_LISTS,
  paintsInterest,
  phraseListsFor,
  NO_PHRASES,
} from "../paint";
import type { GrammarLists, ListSnapshot, PaintLists, PhraseLists } from "../paint";
import { segsNode, tokenSpan } from "../prep-render";
import { epLabel, nextEpisode } from "../series";
import {
  autoplayNext,
  cachePrep,
  getCachedJobs,
  getCachedPrep,
  getTaps,
  queuePassive,
  queueWatched,
} from "../store";
import { onTapSync, scheduleTapSync, syncTapsNow } from "../livesync";
import { ratingBlock, removeJob } from "./queue";
import { flushSoon } from "../sync";
import { ViewRecorder } from "../viewtime";
import {
  clearPosition,
  getPosition,
  getVideoRecord,
  loadLocalDefinitions,
  loadLocalTranscript,
  refreshSidecars,
  sidecarsOutdated,
  savePosition,
} from "../video";
import { downloadStatus } from "../downloads";
import type {
  FollowState,
  GrammarPoint,
  Definitions,
  Job,
  PaintState,
  PrepDoc,
  SentenceGrammar,
  SentencePhrase,
  TapMark,
  Token,
} from "../types";

// the popup card and the highlight pass are shared with the readers now —
// re-exported so existing imports (tests, tokenHighlight callers) keep working
export type { KeywordInfo } from "../gloss-popup";
export type { SubTier } from "../highlight";
export { getSubTier, isIplus1, setSubTier, soleUnknown, SUB_TIERS, tokenHighlight } from "../highlight";

/** One subtitle cue: tokenized (tappable) or plain text (SRT fallback). */
export interface Cue {
  start: number;
  end: number;
  /** The ASR end time, before extendCues() lingers `end` — roll-up pacing
      spreads the lines over start→speechEnd so text tracks the speech. */
  speechEnd?: number;
  cls?: string; // coverage classification (i_plus_1/…) — absent on old sidecars
  tokens?: Token[];
  text?: string;
  grammar?: SentenceGrammar[]; // curated line context (GRAMMAR.md)
  phrases?: SentencePhrase[];
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
    return { ...c, end, speechEnd: c.end };
  });
}

// --- roll-up chunking --------------------------------------------------------
// A cue that wraps past ~2 lines would swallow the frame, so long cues are
// split into lines that fit the overlay and shown through a 2-line roll-up
// window. Tokens carry no timestamps (only the sentence does), so each line's
// screen time is its proportional share — by visual width — of the cue's
// start→speechEnd span.

/** Visual width of a string in ems: CJK glyphs are full-width, the rest ~half. */
export function textEms(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) < 0x2e80 ? 0.5 : 1;
  return n;
}

// Closing punctuation must not orphan onto the next line — let it overflow.
const CLOSERS = new Set("、。！？!?…‥,.)]」』】〉》）　 ");
const isCloser = (s: string) => [...s].every((ch) => CLOSERS.has(ch));

/** Greedy line fill: tokens never split; a closer squeezes onto a full line. */
export function chunkTokens(tokens: Token[], budget: number): Token[][] {
  const lines: Token[][] = [];
  let line: Token[] = [];
  let used = 0;
  for (const t of tokens) {
    const w = textEms(t.s);
    if (line.length && used + w > budget && !isCloser(t.s)) {
      lines.push(line);
      line = [];
      used = 0;
    }
    line.push(t);
    used += w;
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [tokens];
}

/** Plain-SRT fill: hard newlines break, then characters fill to the budget. */
export function chunkText(text: string, budget: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    let used = 0;
    for (const ch of para) {
      if (line && used + textEms(ch) > budget && !CLOSERS.has(ch)) {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += ch;
      used += textEms(ch);
    }
    if (line.trim()) lines.push(line);
  }
  return lines.length ? lines : [text];
}

/** Real start times per roll-up line, from ASR-aligned token times (Token.t —
    ASR episodes only): each line starts at its first timed token, line 0 is
    clamped to the cue start, and clock glitches are forced monotonic. Returns
    null when any line lacks a timed token (hand-crafted subs, old sidecars) —
    the caller then paces by visual weight instead. */
export function lineStartTimes(c: Cue, lines: Token[][]): number[] | null {
  const starts: number[] = [];
  for (const line of lines) {
    const t = line.find((tk) => tk.t != null)?.t;
    if (t == null) return null;
    starts.push(t);
  }
  starts[0] = c.start;
  for (let k = 1; k < starts.length; k++)
    starts[k] = Math.max(starts[k], starts[k - 1]);
  return starts;
}

/** Which line is live at t given real line start times: the last one started
    (line 0 before any start; the last line holds through the linger tail). */
export function lineIndexAtTimes(starts: number[], t: number): number {
  let k = 0;
  while (k + 1 < starts.length && t >= starts[k + 1]) k++;
  return k;
}

/** Which line is live at time t: weights split start→speechEnd proportionally;
    past speechEnd (the linger tail) the last line stays up. The fallback
    pacing for cues without ASR-aligned token times. */
export function chunkIndexAt(c: Cue, weights: number[], t: number): number {
  if (weights.length <= 1) return 0;
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const dur = Math.max((c.speechEnd ?? c.end) - c.start, 0.001);
  const frac = Math.min(Math.max((t - c.start) / dur, 0), 1);
  let acc = 0;
  for (let k = 0; k < weights.length - 1; k++) {
    acc += weights[k] / total;
    if (frac < acc) return k;
  }
  return weights.length - 1;
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

// --- subtitle prefs: size · height · highlight tier -------------------------
// Global viewing preferences like SubMode, not per-episode. Size scales the
// overlay font; rise lifts the line off the bottom edge in 5% steps (clear of
// hardsubs / letterbox bars).

export const SUB_SIZES = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2];
const SUB_SIZE_KEY = "fp.sub.size";

export function getSubSize(): number {
  const n = Number(localStorage.getItem(SUB_SIZE_KEY));
  return SUB_SIZES.includes(n) ? n : 1;
}

export function stepSubSize(dir: 1 | -1): number {
  const i = Math.max(0, Math.min(SUB_SIZES.length - 1, SUB_SIZES.indexOf(getSubSize()) + dir));
  localStorage.setItem(SUB_SIZE_KEY, String(SUB_SIZES[i]));
  return SUB_SIZES[i];
}

export const SUB_RISE_MAX = 8; // steps of 5% → 0–40% up the stage
const SUB_RISE_KEY = "fp.sub.rise";

export function getSubRise(): number {
  const n = Number(localStorage.getItem(SUB_RISE_KEY));
  return Number.isInteger(n) && n >= 0 && n <= SUB_RISE_MAX ? n : 0;
}

export function stepSubRise(dir: 1 | -1): number {
  const n = Math.max(0, Math.min(SUB_RISE_MAX, getSubRise() + dir));
  localStorage.setItem(SUB_RISE_KEY, String(n));
  return n;
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

/** Grammar patterns on this cue that sit in the confirm queue and have no
    span to paint (curate-only tags) — the line badge covers those; a
    placed unit paints its own span blue instead. */
export function cueGrammarConfirm(c: Cue, grammarConfirm: ReadonlySet<string>): string[] {
  return (c.grammar ?? []).filter((g) => g.start == null)
    .map((g) => g.pattern).filter((p) => grammarConfirm.has(p));
}

/** kw-mode gate: does this line carry a noted keyword or a ★ word (marked
    here, or standing interest from any other show)? */
export function cueTriggered(
  c: Cue,
  keywords: Map<string, KeywordInfo>,
  taps: Record<string, TapMark>,
  interest: ReadonlySet<string> = NO_CONFIRM,
): boolean {
  return !!c.tokens?.some(
    (t) => t.l && (keywords.has(t.l) || paintsInterest(taps[t.l], t.l, interest)),
  );
}

export function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** Tokenized cues + ranked high-value lemmas for the episode: local sidecar →
    server → null (SRT era). `candidates` is empty on old sidecars; `curated`
    false means the sidecar predates curation (no grammar/phrase notes yet) —
    the player then tries a background refresh. */
async function loadTokenCues(
  ep: string,
): Promise<{
  cues: Cue[];
  candidates: string[];
  snapshot: ListSnapshot; // the sidecar's copy of the global lists
  curated: boolean;
  grammarPoints: Record<string, GrammarPoint>; // gloss + tier per pattern on any line
} | null> {
  const snap = (d: ListSnapshot): ListSnapshot => ({
    confirm: d.confirm,
    interest: d.interest,
    should_know: d.should_know,
  });
  const local = await loadLocalTranscript(ep);
  if (local?.sentences?.length)
    return {
      cues: local.sentences,
      candidates: local.candidates ?? [],
      snapshot: snap(local),
      curated: local.curated ?? false,
      grammarPoints: local.grammar_points ?? {},
    };
  try {
    const doc = await api.getTranscript(ep);
    if (doc.sentences?.length)
      return {
        cues: doc.sentences,
        candidates: doc.candidates ?? [],
        snapshot: snap(doc),
        curated: true,
        grammarPoints: doc.grammar_points ?? {},
      };
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
  const title =
    getCachedPrep(episodeId)?.episode.title ||
    getCachedJobs()?.jobs.find((j) => j.episode_id === episodeId)?.title;
  if (title) root.appendChild(el("h1", "", title));

  // immersion time (viewtime.ts): every timeupdate tick feeds the recorder;
  // seeks re-anchor, rewinds count again, and the sitting closes on leave —
  // or on the 🎧 handoff, after which the native service logs it (still as
  // watching: audio-only here is not the passive queue)
  const recorder = new ViewRecorder({
    episodeId, title: title || episodeId, kind: "watch",
    state: () => getSubMode(), // the 🎧 handoff closes this recorder; the service's time is `audio`
    // the sitting was handed over mid-play (past the finished bar, or the
    // video ended): push it to the server now, so the queue row flips to
    // watched here instead of with the first tap in the next episode
    // (2026-09-20). Fire-and-forget — playback never waits on the network.
    onSplit: () => flushSoon(),
  });

  const stage = el("div", "player-stage");
  const video = el("video") as HTMLVideoElement;
  video.playsInline = true;
  video.preload = "metadata";
  const overlay = el("div", "subs-overlay");
  const popup = createGlossPopup({
    episodeId,
    defs: () => defs,
    keywords: () => keywords,
    grammar: () => grammarLists,
    grammarPoints: () => grammarPoints,
    interest: () => lists.interest,
    phrases: () => phraseLists,
    // a watch-time mark syncs on its own (livesync.ts) — nothing to submit
    onMarkChanged: () => {
      paintTaps();
      scheduleTapSync(episodeId);
    },
    // the live `k` flag (applyPaintKnown) says known; else the list it is on
    listOf: (lemma, ti, sentence) =>
      lookupListOf(lemma, lists, !!(ti != null && sentence?.tokens?.[ti]?.k)),
    onLookup: () => scheduleTapSync(episodeId),
    mode: () => (audioMode ? "audio" : getSubMode()),
  });
  stage.append(video, overlay, popup.el);

  // high-value lemmas for the focus tier: the transcript's ranked candidates,
  // else (old sidecar) the prep glossary — keywords win priority either way
  let highValue = new Set<string>();
  // the ledger's three global lists narrowed to this episode (blue / purple
  // / green) — the live paint state's when we have one, else the
  // transcript's snapshot, plus this phone's own marks
  let lists: PaintLists = NO_LISTS;
  // the phrase axis (paint.ts): each curated phrase span paints from its own
  // state, never its tokens' — the words-known / phrase-unknown gap shows
  let phraseLists: PhraseLists = NO_PHRASES;
  // the grammar axis (paint.ts): each detected unit paints from the
  // pattern's own state — 〜てしまう can be unknown while 食べる and て are known
  let grammarLists: GrammarLists = NO_GRAMMAR;
  let grammarPoints: Record<string, GrammarPoint> = {};
  let snapshot: ListSnapshot = {};
  // curate-only line patterns (no span) in the confirm queue (line badge)
  let grammarConfirm: ReadonlySet<string> = NO_CONFIRM;
  // paint.ts: the ledger's lists as of now, overlaid on the cached sidecar
  // (known is additive; the lists and grammar replace the snapshot)
  let paint: PaintState | null = getCachedPaint(episodeId);
  const applyPaint = (doc: ListSnapshot) => {
    snapshot = doc;
    applyPaintKnown(cues, paint);
    lists = listsFor(paint, doc);
    phraseLists = phraseListsFor(paint);
    grammarLists = grammarListsFor(paint);
    grammarConfirm = grammarLists.confirm;
  };
  const fallbackHighValue = (doc: PrepDoc | null) => {
    if (!highValue.size && doc) highValue = new Set(doc.glossary.map((g) => g.lemma));
  };

  // the curated synopsis (あらすじ) — the one piece of the old prep page
  // that survives, under the video
  const synopsis = el("div", "synopsis");
  synopsis.hidden = true;
  const showSynopsis = (doc: PrepDoc | null) => {
    const cur = doc?.curate;
    if (!cur?.synopsis) return;
    synopsis.textContent = "";
    if (cur.synopsis_segs?.length) synopsis.appendChild(segsNode(cur.synopsis_segs));
    else synopsis.textContent = cur.synopsis;
    synopsis.hidden = false;
  };

  // keyword glosses/notes + synopsis from the prep doc (cache-first; the
  // fetch is best-effort — without it keywords just aren't special and the
  // synopsis stays blank). A doc cached before curation lacks both, so it
  // is refetched.
  const cachedDoc = getCachedPrep(episodeId);
  let keywords = keywordIndex(cachedDoc);
  showSynopsis(cachedDoc);
  if (!keywords.size || !cachedDoc?.curate) {
    void api
      .getPrep(episodeId)
      .then((doc) => {
        cachePrep(doc);
        keywords = keywordIndex(doc);
        fallbackHighValue(doc);
        showSynopsis(doc);
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
  const audioBtn = el("button", "pv", "🎧") as HTMLButtonElement;
  audioBtn.title = "listen as background audio (screen off)";
  const playBtn = el("button", "pv", "▶") as HTMLButtonElement;
  const prevBtn = el("button", "pv", "⏮") as HTMLButtonElement;
  const nextBtn = el("button", "pv", "⏭") as HTMLButtonElement;
  const speedBtn = el("button", "pv", "1×") as HTMLButtonElement;
  const ccBtn = el("button", "pv", "cc") as HTMLButtonElement;
  const rubyBtn = el("button", "pv on", "あ") as HTMLButtonElement;
  const subBtn = el("button", "pv", "Aa") as HTMLButtonElement;
  const fsBtn = el("button", "pv", "⛶") as HTMLButtonElement;
  btnRow.append(audioBtn, prevBtn, playBtn, nextBtn, speedBtn, ccBtn, rubyBtn, subBtn, fsBtn);

  // --- subtitle settings: size / height / highlight tier (Aa toggles) -----
  const applySubPrefs = () => {
    stage.style.setProperty("--sub-scale", String(getSubSize()));
    stage.style.setProperty("--sub-rise", `${getSubRise() * 5}%`);
  };
  applySubPrefs();

  const panel = el("div", "sub-panel");
  panel.style.display = "none";
  const prefRow = (
    label: string,
    dec: string,
    inc: string,
    step: (dir: 1 | -1) => void,
    fmt: () => string,
  ) => {
    const row = el("div", "row");
    const val = el("span", "val", fmt());
    const btn = (txt: string, dir: 1 | -1) => {
      const b = el("button", "", txt) as HTMLButtonElement;
      b.addEventListener("click", () => {
        step(dir);
        val.textContent = fmt();
        applySubPrefs();
        repaintCue(); // font size changes the line budget → re-chunk
      });
      return b;
    };
    row.append(el("span", "lab", label), btn(dec, -1), val, btn(inc, +1));
    return row;
  };
  panel.append(
    prefRow("size", "A−", "A+", (d) => void stepSubSize(d), () => `${getSubSize()}×`),
    prefRow("height", "▼", "▲", (d) => void stepSubRise(d), () => `${getSubRise() * 5}%`),
  );
  const tierRow = el("div", "row");
  tierRow.appendChild(el("span", "lab", "marks"));
  const tierBtns = SUB_TIERS.map((t) => {
    const b = el("button", "tier", t) as HTMLButtonElement;
    b.addEventListener("click", () => {
      setSubTier(t);
      syncTierBtns();
      repaintCue();
    });
    tierRow.appendChild(b);
    return b;
  });
  const syncTierBtns = () =>
    tierBtns.forEach((b, i) => b.classList.toggle("on", SUB_TIERS[i] === getSubTier()));
  syncTierBtns();
  panel.appendChild(tierRow);

  subBtn.addEventListener("click", () => {
    const open = panel.style.display === "none";
    panel.style.display = open ? "" : "none";
    subBtn.classList.toggle("on", open);
  });

  controls.append(seekRow, btnRow, panel);

  // --- under the video: synopsis · rating · delete / passive / mint cards --
  const under = el("div", "player-under");
  const barStatus = el("div", "muted bar-status");

  // the queue row: state (has the close-out run?), rating prefill, and the
  // Job the delete needs — the cached snapshot first (works offline), then
  // the live row
  let job: Job | undefined = getCachedJobs()?.jobs.find((j) => j.episode_id === episodeId);

  // Rating + tags (SURVEY.md) — ratable any time, not only after the credits.
  // Engaging it guards the server prefill from clobbering a rating in
  // progress.
  let engaged = false;
  const stars = el("div", "player-rating");
  const mountRating = (
    rating: number | null,
    tags: string[],
    axes: Record<string, number> = {},
    follow: FollowState | null = null,
  ) => {
    stars.textContent = "";
    stars.appendChild(
      ratingBlock(
        episodeId,
        rating,
        tags,
        () => (engaged = true),
        () => (barStatus.textContent = "rating queued — will sync when reachable"),
        axes,
        follow,
      ),
    );
  };
  mountRating(job?.rating ?? null, job?.tags ?? [], job?.axes ?? {}, job?.follow ?? null);
  void api
    .getJob(episodeId)
    .then((j) => {
      job = j;
      if (!engaged) mountRating(j.rating ?? null, j.tags ?? [], j.axes ?? {}, j.follow ?? null);
    })
    .catch(() => {});

  const actions = el("div", "bar-row");
  const deleteBtn = el("button", "", "🗑 delete") as HTMLButtonElement;
  deleteBtn.title = "Delete this episode (video, prep, server artifacts)";
  const passiveBtn = el("button", "", "🎧 passive") as HTMLButtonElement;
  passiveBtn.title = "Done watching — keep it on the Listen tab for passive audio";
  const mintBtn = el("button", "", "🃏 mint cards") as HTMLButtonElement;
  mintBtn.title = "Push this episode's selected cards to Anki";
  actions.append(deleteBtn, passiveBtn, mintBtn);
  under.append(synopsis, stars, actions, barStatus);

  // Delete = the queue row's swipe-delete, with the same confirm and the same
  // cost (removeJob: server purge for a standalone episode, phone-local for a
  // series episode). The file may be open in <video> — pause first; the
  // route-away cleanup detaches it.
  deleteBtn.addEventListener("click", () => {
    const j = job;
    if (!j) {
      barStatus.textContent = "⚠ queue row not loaded — delete from the queue screen";
      return;
    }
    if (!audioMode) video.pause();
    void removeJob(j, () => (location.hash = "#/queue"));
  });

  // Passive = done watching, shelve onto the Listen tab. The server only
  // shelves a watched row, so an episode whose close-out hasn't run yet is
  // marked watched first (no cards — minting is its own button). Offline:
  // both land in the outbox in that order (FIFO).
  const closedOut = () => job?.state === "watched" || job?.state === "pushing";
  passiveBtn.addEventListener("click", async () => {
    passiveBtn.disabled = true;
    try {
      await syncTapsNow(episodeId); // a mark still debouncing goes first
      if (!closedOut()) await api.markWatched(episodeId, false);
      job = await api.setPassive(episodeId, true);
      barStatus.textContent = "🎧 on the Listen tab";
    } catch (e) {
      if (e instanceof ApiError && e.status === undefined) {
        if (!closedOut()) queueWatched(episodeId, false);
        queuePassive(episodeId, true);
        barStatus.textContent = "🎧 on the Listen tab · queued offline — syncs when reachable";
        return;
      }
      barStatus.textContent = `⚠ ${(e as Error).message}`;
      passiveBtn.disabled = false;
    }
  });

  // Mint cards = the deck push (tools/deck.py): the server activates the
  // episode's exposures if play time hasn't already, then pushes the
  // feedback-selected cards to Anki in the background — the queue row
  // narrates it (`pushing` → `watched`) and carries any failure + retry.
  mintBtn.addEventListener("click", async () => {
    mintBtn.disabled = true;
    try {
      await syncTapsNow(episodeId);
      const res = await api.markWatched(episodeId, true);
      const c = res.cards;
      if (c?.error) {
        barStatus.textContent = `⚠ cards failed: ${c.error} — tap again to retry`;
        mintBtn.disabled = false;
        return;
      }
      barStatus.textContent = c?.queued
        ? `minting ${c.queued} card${c.queued > 1 ? "s" : ""} in the background (see queue)`
        : `no cards minted — ${c?.note ?? "nothing selected"}`;
      if (job) job = { ...job, state: "pushing" };
    } catch (e) {
      if (e instanceof ApiError && e.status === undefined) {
        queueWatched(episodeId, true);
        barStatus.textContent = "mint queued offline — syncs when reachable";
        return;
      }
      barStatus.textContent = `⚠ ${(e as Error).message}`;
      mintBtn.disabled = false;
    }
  });

  root.append(stage, controls, status, under);

  // --- subtitles ---------------------------------------------------------
  let cues: Cue[] = [];
  let current = -2; // ≠ -1 so the first timeupdate paints even in a gap
  let lineIdx = -1; // roll-up line within the current cue
  let cueLines: Token[][] | string[] = []; // the current cue, chunked
  let lineWeights: number[] = []; // ems per line → each line's time share
  let lineStarts: number[] | null = null; // ASR-aligned starts; null → weights
  let badgeLine = 0; // which line carries the +1 badge (the target's line)

  /** In-place repaint of the spans on screen after a mark moves: the global
      lists are recomputed (a ★ takes a word from green to purple, a ✓ ends
      both), each word's highlight is re-derived (highlight.ts — the same
      pass the manga reader runs), and the tap classes layered on top.
      Keeps the span elements, so an open popup stays anchored. */
  const paintTaps = () => {
    lists = listsFor(paint, snapshot);
    phraseLists = phraseListsFor(paint);
    grammarLists = grammarListsFor(paint);
    const c = current >= 0 ? cues[current] : undefined;
    paintWordSpans(overlay, () => c, {
      episodeId, tier: getSubTier(), lists, phraseLists, grammarLists, keywords, highValue,
    });
  };

  /** Line capacity in ems (CJK glyph ≈ 1em). Falls back to a wide budget when
      unlaid-out (tests / display:none) so short cues stay whole. */
  const budgetEms = () => {
    const fs = parseFloat(getComputedStyle(overlay).fontSize) || 21;
    return Math.max(6, ((overlay.clientWidth || 640) - 20) / fs);
  };

  const renderLine = (k: number): HTMLElement => {
    const line = el("div", "sub-line");
    const chunk = cueLines[k];
    if (typeof chunk === "string") {
      line.textContent = chunk;
      return line;
    }
    const c = cues[current];
    const tier = getSubTier();
    const target = soleUnknown(c);
    if (tier !== "off" && isIplus1(c) && k === badgeLine)
      line.appendChild(el("span", "iplus-badge", "+1"));
    // a grammar point on this line is waiting for your yes/no (blue, like a
    // word in the same queue) — badge the first line; tap any word for it
    if (tier !== "off" && k === 0 && cueGrammarConfirm(c, grammarConfirm).length) {
      const b = el("span", "know-badge", "?");
      b.title = "grammar point on this line — do you know it? (Progress tab)";
      line.appendChild(b);
    }
    for (const t of chunk) {
      const n = tokenSpan(t, null, true); // any word answers a tap
      if (n instanceof HTMLElement) {
        // index within the cue's full token list → inflection-chain lookup
        n.dataset.ti = String(c.tokens!.indexOf(t));
        const hl = tokenHighlight(t, tier, keywords, highValue, target, c.cls, lists);
        if (hl) n.classList.add(hl);
      }
      line.appendChild(n);
    }
    return line;
  };

  /** Paint the 2-line window for line k: k above the fold when rolling on
      sequentially, else a fresh window (k-1 dimmed above, k below). */
  const showLine = (k: number) => {
    const roll = k === lineIdx + 1 && overlay.lastElementChild != null;
    lineIdx = k;
    if (roll) {
      while (overlay.children.length > 1) overlay.firstElementChild!.remove();
      overlay.lastElementChild!.classList.add("prev");
      const line = renderLine(k);
      line.classList.add("enter");
      overlay.appendChild(line);
    } else {
      overlay.textContent = "";
      if (k > 0) {
        const prev = renderLine(k - 1);
        prev.classList.add("prev");
        overlay.appendChild(prev);
      }
      overlay.appendChild(renderLine(k));
    }
    paintTaps();
  };

  /** Live line for the current cue: real ASR-aligned starts when the tokens
      carry them, else proportional-by-width (hand-crafted subs, old sidecars). */
  const liveLine = (c: Cue, t: number) =>
    lineStarts ? lineIndexAtTimes(lineStarts, t) : chunkIndexAt(c, lineWeights, t);

  const showCue = (i: number) => {
    current = i;
    lineIdx = -1;
    cueLines = [];
    lineWeights = [];
    lineStarts = null;
    overlay.textContent = "";
    if (i < 0) return;
    const c = cues[i];
    const mode = getSubMode();
    if (mode === "off") return;
    if (mode === "kw" && !cueTriggered(c, keywords, getTaps(episodeId), lists.interest)) return;
    const budget = budgetEms();
    if (c.tokens) {
      const lines = chunkTokens(c.tokens, budget);
      cueLines = lines;
      lineWeights = lines.map((l) => l.reduce((n, t) => n + textEms(t.s), 0));
      lineStarts = lineStartTimes(c, lines);
      const target = soleUnknown(c);
      badgeLine = Math.max(0, lines.findIndex((l) => l.some((t) => t.l === target)));
    } else if (c.text) {
      const lines = chunkText(c.text, budget);
      cueLines = lines;
      lineWeights = lines.map(textEms);
      badgeLine = 0;
    } else return;
    showLine(liveLine(c, video.currentTime));
  };
  const repaintCue = () => showCue(cueIndexAt(cues, video.currentTime));

  // tap any word → the shared gloss popup (gloss-popup.ts): curated notes,
  // inflection, compounds, JMdict senses, and the mark cycle all live there
  overlay.addEventListener("click", (e) => {
    const w = (e.target as HTMLElement).closest<HTMLElement>(".w[data-lemma]");
    if (!w) return;
    e.stopPropagation(); // don't fall through to the stage's play/pause toggle
    popup.show(
      w.dataset.lemma!,
      w.dataset.ti != null ? Number(w.dataset.ti) : undefined,
      cues[current],
    );
  });

  void (async () => {
    try {
      const tokenized = await loadTokenCues(episodeId);
      if (tokenized) {
        cues = extendCues(tokenized.cues);
        highValue = new Set(tokenized.candidates);
        grammarPoints = tokenized.grammarPoints;
        applyPaint(tokenized.snapshot);
        fallbackHighValue(getCachedPrep(episodeId));
        // then the live lists: what's become known / entered a list since
        // this sidecar was pulled — repaint if the server answers
        const livePaint = () =>
          fetchPaint(episodeId).then((fresh) => {
            if (!fresh || !root.isConnected) return;
            paint = fresh;
            applyPaint(snapshot);
            repaintCue();
          });
        void livePaint();
        // and again after each mark batch lands: the ledger re-judges on the
        // spot (a ✗ can put a word straight onto blue / green), so the
        // promotion shows in this sitting, not the next
        onTapSync((ep, result) => {
          if (ep === episodeId && result?.sent && root.isConnected) void livePaint();
        });
        if (!tokenized.curated || sidecarsOutdated(episodeId)) {
          // sidecar was downloaded pre-curation (no grammar/phrase notes, no
          // curate-authored defs) or on an old wire format (e.g. content-
          // lemma-only definitions) — refresh in the background and repaint
          void refreshSidecars(episodeId).then(async (fresh) => {
            if (!fresh?.curated || !root.isConnected) return;
            cues = extendCues(fresh.sentences);
            highValue = new Set(fresh.candidates ?? []);
            applyPaint(fresh);
            fallbackHighValue(getCachedPrep(episodeId));
            defs = (await loadLocalDefinitions(episodeId)) ?? defs;
            repaintCue();
          });
        }
      } else {
        cues = extendCues(await loadSrtCues(episodeId));
        status.textContent = "plain subs (no tokenized transcript) — taps unavailable";
      }
      repaintCue();
    } catch (e) {
      status.textContent = `subs unavailable: ${(e as Error).message}`;
    }
  })();

  // --- source: the downloaded file (everything is local-first) ------------
  // the raw file:// URI is also what audio mode hands to the native service
  let fileUri: string | null = null;
  void (async () => {
    const rec = getVideoRecord(episodeId);
    if (!rec) {
      status.textContent = downloadStatus(episodeId)
        ? "⬇ still downloading — it plays once the download finishes"
        : "⚠ not downloaded — ⬇ video on the queue screen first";
      return;
    }
    try {
      const { uri } = await Filesystem.getUri({ path: rec.path, directory: Directory.Data });
      fileUri = uri;
      video.src = Capacitor.convertFileSrc(uri);
    } catch (e) {
      status.textContent = `⚠ ${(e as Error).message}`;
    }
  })();

  video.addEventListener("error", () => {
    status.textContent = "⚠ playback failed — re-download the video from the queue screen";
  });

  // --- series: up next --------------------------------------------------------
  // When a box-set episode ends, offer the next one (series.ts order) with a
  // countdown when it's already on the phone — back-to-back watching without
  // a trip through the queue. Watched follows from play time server-side,
  // so the card only navigates.
  const upnext = el("div", "upnext");
  upnext.hidden = true;
  stage.appendChild(upnext);
  let countdown: number | undefined;
  const hideUpnext = () => {
    if (countdown) clearInterval(countdown);
    countdown = undefined;
    upnext.hidden = true;
  };
  video.addEventListener("ended", () => {
    recorder.split(); // the sitting reaches the server before the up-next card
    const jobs = getCachedJobs()?.jobs ?? [];
    const next = nextEpisode(jobs, episodeId);
    upnext.textContent = "";
    if (!next) return;
    const downloaded = !!getVideoRecord(next.episode_id);
    upnext.appendChild(el("div", "muted", "up next"));
    upnext.appendChild(el("div", "upnext-title", `${epLabel(next)} · ${next.title || next.episode_id}`));
    const row = el("div", "btnrow");
    const go = () => {
      hideUpnext();
      location.hash = `#/player/${encodeURIComponent(next.episode_id)}`;
    };
    if (downloaded) {
      const playNext = el("button", "primary", "▶ play now") as HTMLButtonElement;
      playNext.addEventListener("click", go);
      row.appendChild(playNext);
    } else {
      upnext.appendChild(el("div", "muted", "not on the phone yet — ⬇ it from the queue"));
    }
    const stay = el("button", "", "stay here") as HTMLButtonElement;
    stay.addEventListener("click", hideUpnext);
    row.appendChild(stay);
    upnext.appendChild(row);
    upnext.hidden = false;
    if (downloaded && autoplayNext()) {
      let left = 8;
      const tick = el("div", "muted", `playing in ${left}s`);
      upnext.appendChild(tick);
      countdown = window.setInterval(() => {
        left -= 1;
        tick.textContent = `playing in ${left}s`;
        if (left <= 0) go();
      }, 1000);
    }
  });
  video.addEventListener("play", hideUpnext);

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

  const updateClock = (t?: number) => {
    clock.textContent = `${fmtClock(t ?? video.currentTime)} / ${fmtClock(video.duration)}`;
  };

  let scrubbing = false;
  video.addEventListener("timeupdate", () => {
    const i = cueIndexAt(cues, video.currentTime);
    if (i !== current) showCue(i);
    else if (i >= 0 && cueLines.length > 1) {
      const k = liveLine(cues[i], video.currentTime);
      if (k !== lineIdx) showLine(k);
    }
    if (!scrubbing) scrub.value = String(video.currentTime);
    updateClock();
    recorder.tick(video.currentTime, video.playbackRate, video.duration);
    if (Math.abs(video.currentTime - lastSaved) > 5) {
      lastSaved = video.currentTime;
      savePos();
    }
  });
  video.addEventListener("seeking", () => recorder.reanchor());

  scrub.addEventListener("pointerdown", () => (scrubbing = true));
  scrub.addEventListener("input", () => {
    // audio mode seeks the native service on release (change) — per-input
    // bridge calls would flood MediaPlayer.seekTo; just preview the clock
    if (audioMode) updateClock(Number(scrub.value));
    else video.currentTime = Number(scrub.value);
  });
  scrub.addEventListener("change", () => {
    scrubbing = false;
    if (audioMode)
      void PassiveAudio.seekTo({ positionMs: Math.floor(Number(scrub.value) * 1000) })
        .catch(() => {});
  });

  // --- audio mode: hand the current position to the native passive-audio
  // service so playback survives the screen turning off (the Listen tab's
  // foreground service + lock-screen controls), then take it back on toggle.
  let audioMode = false;
  let audioListener: Promise<PluginListenerHandle> | null = null;
  let audioPosSec = 0; // last position tick from the service — anchors seekCue

  const attachAudioListener = () => {
    audioListener = PassiveAudio.addListener("state", (s) => {
      if (!audioMode) return;
      playBtn.textContent = s.playing ? "⏸" : "▶";
      if (s.positionMs != null) {
        audioPosSec = s.positionMs / 1000;
        if (!scrubbing) {
          scrub.value = String(audioPosSec);
          updateClock(audioPosSec);
        }
      }
    });
  };

  const setAudioMode = (on: boolean) => {
    audioMode = on;
    audioBtn.classList.toggle("on", on);
    audioBtn.title = on
      ? "playing as background audio — tap for video"
      : "listen as background audio (screen off)";
    root.classList.toggle("audio-mode", on);
    status.textContent = on ? "🎧 audio mode — keeps playing with the screen off" : "";
  };

  const enterAudio = async () => {
    if (!fileUri) {
      status.textContent = "⚠ video still loading…";
      return;
    }
    const startMs = Math.floor(video.currentTime * 1000);
    video.pause();
    recorder.close(); // from here the service keeps the time — still as watching
    setAudioMode(true);
    playBtn.textContent = "⏸";
    audioPosSec = video.currentTime;
    try {
      await PassiveAudio.play({
        items: [{ src: fileUri, title: title || episodeId, episodeId }],
        startIndex: 0,
        speed: SPEEDS[speedIdx],
        // < 0 forces the top of the track — 0 would mean "resume from the
        // service's persisted position", but this is an exact handoff
        startPositionMs: startMs > 0 ? startMs : -1,
        // audio-only is still this episode being actively followed, not
        // the passive queue — its minutes stay on the watching side
        kind: "watch",
      });
      attachAudioListener();
    } catch (e) {
      setAudioMode(false);
      status.textContent = `⚠ ${(e as Error).message}`;
    }
  };

  const exitAudio = async () => {
    let posSec = video.currentTime;
    try {
      const st = await PassiveAudio.getState();
      if (st.positionMs != null && st.positionMs > 0) posSec = st.positionMs / 1000;
      await PassiveAudio.stop();
    } catch {
      /* nothing playing — just fall back to the video's own position */
    }
    void (await audioListener)?.remove();
    audioListener = null;
    setAudioMode(false);
    if (Number.isFinite(posSec) && posSec > 0) video.currentTime = posSec;
    void video.play().catch(() => {});
  };

  audioBtn.addEventListener("click", () => void (audioMode ? exitAudio() : enterAudio()));

  // returning to the player while this episode is already playing in the
  // background: pick the audio session back up instead of starting a new one
  void PassiveAudio.getState()
    .then((s) => {
      if (!audioMode && s.running && s.episodeId === episodeId) {
        setAudioMode(true);
        playBtn.textContent = s.playing ? "⏸" : "▶";
        attachAudioListener();
      }
    })
    .catch(() => {});

  // --- transport ----------------------------------------------------------
  const togglePlay = () => {
    if (audioMode) {
      void PassiveAudio.toggle();
      return;
    }
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };
  playBtn.addEventListener("click", togglePlay);
  stage.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".w")) return; // word tap, not pause
    if (popup.visible) {
      popup.hide(); // first tap-away just closes the popup
      return;
    }
    togglePlay();
  });
  video.addEventListener("play", () => (playBtn.textContent = "⏸"));
  video.addEventListener("pause", () => {
    playBtn.textContent = "▶";
    savePos();
  });

  // prev/next anchor on the last cue that *started* (works in gaps too); in
  // audio mode the anchor is the service's last position tick and the seek
  // goes over the bridge
  const seekCue = (offset: number) => {
    if (!cues.length) return;
    const at = audioMode ? audioPosSec : video.currentTime;
    const anchor = lastStartedAt(cues, at);
    const i = Math.max(0, Math.min(cues.length - 1, (anchor < 0 ? 0 : anchor) + offset));
    if (audioMode) {
      audioPosSec = cues[i].start;
      void PassiveAudio.seekTo({ positionMs: Math.floor(cues[i].start * 1000) }).catch(() => {});
      return;
    }
    video.currentTime = cues[i].start;
    showCue(cueIndexAt(cues, video.currentTime));
  };
  prevBtn.addEventListener("click", () => seekCue(-1));
  nextBtn.addEventListener("click", () => seekCue(+1));

  let speedIdx = 0;
  speedBtn.addEventListener("click", () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    video.playbackRate = SPEEDS[speedIdx];
    speedBtn.textContent = `${SPEEDS[speedIdx]}×`;
    if (audioMode) void PassiveAudio.setSpeed({ speed: SPEEDS[speedIdx] });
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

  // rotation / fullscreen change the overlay width → re-chunk the line fill
  const onResize = () => repaintCue();
  window.addEventListener("resize", onResize);
  const onVisibility = () => {
    if (document.hidden) {
      savePos();
      recorder.checkpoint(); // Android may kill the webview while we're away
    } else if (!video.paused) void acquireWake(); // the lock drops when backgrounded
  };
  document.addEventListener("visibilitychange", onVisibility);

  // --- teardown: a detached <video> keeps playing, so stop it on route-away.
  // Audio mode is deliberately NOT stopped — leaving the screen is the whole
  // point (it plays on in the background); we only drop our state listener.
  const cleanup = () => {
    hideUpnext();
    savePos();
    recorder.close();
    flushSoon(); // don't sit on the sitting until the next tap/rating
    video.pause();
    video.removeAttribute("src");
    video.load();
    releaseWake();
    if (audioListener) void audioListener.then((h) => h.remove());
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", onResize);
  };
  window.addEventListener("hashchange", cleanup, { once: true });

  return root;
}
