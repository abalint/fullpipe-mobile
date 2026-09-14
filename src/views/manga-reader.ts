// Manga reader (#/manga/<id>): one volume from the PC library, page by page,
// with the same tap-a-word machinery as the player and the 5ch reader laid
// invisibly over the art. The PC's OCR (tools.manga) gives every speech
// bubble a box and its printed lines; the transcript gives the tokens; the
// overlay lays the tokens back into the lines (manga-layout.ts blockLines)
// as transparent spans, so the player's word paints (highlight.ts — the
// global lists, high-value candidates, the i+1 target, unknowns, phrase
// spans and grammar units, under the same off / focus / learn tiers) sit on
// the printed words as tinted washes, and a tap on a word opens the shared
// gloss popup with the shared mark cycle — marks sync live as normal tap
// batches, lookups are recorded, all under encounter mode "manga".
//
// Reading behaviours follow the comicReader app: a reading mode — page
// order right-to-left (default) or left-to-right, or a vertical scroll —
// and, separately, continuous scrolling (every page in one strip, fit to
// the width for vertical / the height otherwise, flung with the finger)
// versus one page at a time; both remembered per series and as the default
// for the next series. Paged: tap zones (far side turns forward, centre
// toggles the chrome), swipe to turn at 1× (the page rides with the finger
// and springs back if the swipe doesn't commit), spreads fit to width; a
// zoomed page only pans — never turns — so reading a panel up close can't
// skip ahead. Continuous: no tap zones at all (a tap toggles the chrome) —
// the strip is scrolled, never turned. Always: pinch 1–5× and double-tap 1↔2× about the finger, a
// pan that keeps its momentum after the finger lifts, zoom kept across page
// turns, resume at the last page.
// The stage holds one column element that is translated/scaled: in paged
// mode it carries the current page, in continuous mode the strip with only
// the pages near the viewport mounted. Time on each page (the one under the
// viewport's centre while scrolling) becomes a viewtime sitting whose played
// ranges are page spans (manga.ts ReadRecorder) — the exposure credit is
// exactly the pages read.

import { createGlossPopup } from "../gloss-popup";
import type { PopupSentence } from "../gloss-popup";
import { getSubTier, isTier, paintWordSpans, SUB_TIERS } from "../highlight";
import type { SubTier } from "../highlight";
import { cancelTapSync, onTapSync, scheduleTapSync } from "../livesync";
import {
  blockBox,
  blockLines,
  blockStyle,
  clampView,
  lineStyle,
  DOUBLE_TAP_SCALE,
  fitPage,
  slotAnchor,
  slotAt,
  slotsIn,
  stripFit,
  stripLayout,
  swipeTurnFor,
  tapZoneFor,
  turnPage,
  viewRange,
  viewToSlot,
  zoomAbout,
} from "../manga-layout";
import type { Fit, Slot, Strip, View } from "../manga-layout";
import { glyphSpanBox, lineGlyphs } from "../manga-ink";
import type { LineGlyphs } from "../manga-ink";
import {
  continuousScroll,
  downloadManga,
  getMangaPage,
  getMangaRecord,
  isComplete,
  loadLocalManga,
  loadLocalMangaDefinitions,
  loadLocalMangaTranscript,
  pageImageSrc,
  readingMode,
  ReadRecorder,
  refreshMangaSidecars,
  saveMangaPage,
  setContinuousScroll,
  setReadingMode,
} from "../manga";
import type { ReadingMode } from "../manga";
import {
  applyPaintKnown,
  fetchPaint,
  getCachedPaint,
  grammarListsFor,
  listsFor,
  lookupListOf,
  NO_LISTS,
  phraseListsFor,
  sameLists,
} from "../paint";
import type { ListSnapshot, PaintLists } from "../paint";
import { NO_LOOKUP } from "../prep-render";
import {
  getOutbox,
  getSubmitted,
  pendingTapCount,
  pendingWatched,
  queueWatched,
  submitTaps,
} from "../store";
import { flushOutbox } from "../sync";
import type { Definitions, MangaDoc, MangaPage, TranscriptDoc, TranscriptSentence } from "../types";

const HL_KEY = "fp.manga.hl"; // highlight tier for pages: off / focus / learn
const TIER_LABEL: Record<SubTier, string> = { off: "◨ off", focus: "◨ focus", learn: "◨ learn" };

/** The reader's highlight tier — the player's three tiers, remembered for
    pages on their own (reading a page up close wants a different amount of
    paint than glancing at a subtitle). Starts from the player's tier; the
    old on/off toggle's values read as learn / off. */
export function getMangaTier(): SubTier {
  const raw = localStorage.getItem(HL_KEY);
  if (isTier(raw)) return raw;
  if (raw === "on") return "learn";
  if (raw === "off") return "off";
  return getSubTier();
}

export function setMangaTier(tier: SubTier): void {
  localStorage.setItem(HL_KEY, tier);
}
const TEXT_KEY = "fp.manga.text"; // "on" = OCR text shown (checking the read)
const TAP_MS = 300; // max press for a tap; double-tap window
const TAP_SLOP = 10; // px of movement that still counts as a tap
const SWIPE_PX = 60; // travel along the reading axis that turns a page at 1×
const SNAP_MS = 180; // a 1× page springing back after an uncommitted swipe
const FLING_DECAY = 0.994; // velocity kept per ms after the finger lifts (pans + continuous scroll)
const FLING_MAX = 4; // px/ms
const FLING_STOP = 0.02; // px/ms
const MODES: ReadingMode[] = ["rtl", "ltr", "vertical"];
const MODE_LABEL: Record<ReadingMode, string> = { rtl: "⇄ 右→左", ltr: "⇄ L→R", vertical: "⇅ 縦" };

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function mangaReaderView(episodeId: string): HTMLElement {
  const root = el("div", "view manga-view");
  const stage = el("div", "mg-stage");
  const column = el("div", "mg-column"); // the one transformed element: a page, or the strip
  stage.appendChild(column);
  const status = el("div", "mg-status");
  stage.appendChild(status);

  // --- chrome ------------------------------------------------------------------
  const top = el("div", "mg-bar mg-top");
  const back = el("a", "mg-btn", "‹") as HTMLAnchorElement;
  back.href = "#/pages";
  const titleEl = el("div", "mg-title");
  const hlBtn = el("button", "mg-btn mg-tier", "◨") as HTMLButtonElement;
  hlBtn.title = "highlights: off / focus (lists, high-value, the i+1 target) / learn (+ every unknown)";
  const textBtn = el("button", "mg-btn", "T") as HTMLButtonElement;
  textBtn.title = "show OCR text";
  const modeBtn = el("button", "mg-btn", "⇄") as HTMLButtonElement;
  modeBtn.title = "reading mode: right-to-left / left-to-right / vertical";
  const scrollBtn = el("button", "mg-btn", "∞") as HTMLButtonElement;
  scrollBtn.title = "continuous scrolling";
  const syncEl = el("span", "mg-sync");
  const doneBtn = el("button", "mg-btn mg-done", "✓") as HTMLButtonElement;
  doneBtn.title = "finished reading";
  top.append(back, titleEl, syncEl, hlBtn, textBtn, modeBtn, scrollBtn, doneBtn);
  const bottom = el("div", "mg-bar mg-bottom");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.step = "1";
  slider.className = "mg-slider";
  const counter = el("span", "mg-counter");
  bottom.append(slider, counter);
  root.append(stage, top, bottom);

  const syncHl = () => {
    const tier = getMangaTier();
    hlBtn.textContent = TIER_LABEL[tier];
    hlBtn.classList.toggle("on", tier !== "off");
  };
  hlBtn.addEventListener("click", () => {
    const i = SUB_TIERS.indexOf(getMangaTier());
    setMangaTier(SUB_TIERS[(i + 1) % SUB_TIERS.length]);
    syncHl();
    paintTaps();
  });
  const syncText = () => {
    const on = localStorage.getItem(TEXT_KEY) === "on";
    root.classList.toggle("show-text", on);
    textBtn.classList.toggle("on", on);
  };
  textBtn.addEventListener("click", () => {
    localStorage.setItem(TEXT_KEY, root.classList.contains("show-text") ? "off" : "on");
    syncText();
  });
  syncHl();
  syncText();

  // --- state ---------------------------------------------------------------------
  let doc: MangaDoc | null = null;
  let sentences: TranscriptSentence[] = [];
  let lists: PaintLists = NO_LISTS;
  // the transcript's ranked candidates — the volume's high-value words
  // (pink at focus and above), like the player's
  let highValue = new Set<string>();
  let snapshot: ListSnapshot & Pick<TranscriptDoc, "grammar_points"> = {};
  let defs: Definitions = {};
  let mode: ReadingMode = "rtl";
  let continuous = false;
  let page = 0;
  let fit: Fit = { w: 0, h: 0, x: 0, y: 0, f: 1 };
  let view: View = { s: 1, tx: 0, ty: 0 };
  let strip: Strip | null = null; // continuous mode only
  let recorder: ReadRecorder | null = null;
  const preloaded = new Map<number, HTMLImageElement>();

  /** A page in the column: its box at its slot, the scan, the bubble overlay. */
  interface Mounted {
    box: HTMLElement;
    img: HTMLImageElement;
    overlay: HTMLElement;
    f: number; // the overlay's page px → css px when last rendered
  }
  const mounted = new Map<number, Mounted>();
  /** Measured glyph runs per page (manga-ink.ts): block index → one entry
      per printed line (null where the scan showed no ink). In page px, so
      they survive re-layout and remounting. */
  type PageGlyphs = Map<number, (LineGlyphs | null)[]>;
  const glyphCache = new Map<number, PageGlyphs>();

  const popup = createGlossPopup({
    episodeId,
    defs: () => defs,
    interest: () => lists.interest,
    // the grammar layer's gloss + tier come from the transcript; the
    // grammar / phrase axes (known · think-you-know · ★) from the live paint
    grammarPoints: () => snapshot.grammar_points ?? {},
    grammar: () => grammarListsFor(getCachedPaint(episodeId)),
    phrases: () => phraseListsFor(getCachedPaint(episodeId)),
    onMarkChanged: () => {
      paintTaps();
      scheduleTapSync(episodeId);
      syncState();
    },
    listOf: (lemma, ti, sentence) =>
      lookupListOf(lemma, lists, !!(ti != null && sentence?.tokens?.[ti]?.k)),
    onLookup: () => scheduleTapSync(episodeId),
    mode: () => "manga",
    extraClass: "fixed mg-pop",
  });
  root.appendChild(popup.el);

  // --- paint -----------------------------------------------------------------------
  /** Repaint every span on the mounted pages in place (highlight.ts — the
      player's pass): the global lists are recomputed, each word's paint
      re-derived from its sentence (phrase span › grammar unit › the word),
      the tap marks layered on top. `root` narrows it to one page's overlay
      (a page being laid before its box joins the column). */
  const paintTaps = (root: ParentNode = column) => {
    const paint = getCachedPaint(episodeId);
    lists = listsFor(paint, snapshot);
    paintWordSpans(root, (w) => sentences[Number(w.dataset.si)], {
      episodeId,
      tier: getMangaTier(),
      lists,
      phraseLists: phraseListsFor(paint),
      grammarLists: grammarListsFor(paint),
      highValue,
      submitted: getSubmitted(episodeId),
    });
  };

  const livePaint = () =>
    fetchPaint(episodeId).then((fresh) => {
      if (!fresh || !root.isConnected) return;
      const moved = applyPaintKnown(sentences, fresh);
      const next = listsFor(fresh, snapshot);
      const same = sameLists(next, lists);
      lists = next;
      if (moved || !same) renderOverlay();
    });

  const syncState = () => {
    const n = pendingTapCount(episodeId);
    const queued = getOutbox().some((a) => a.kind === "taps" && a.batch.episode_id === episodeId);
    syncEl.textContent = n ? `⇪${n}` : queued ? "⇪" : "";
  };
  onTapSync((ep, result) => {
    if (ep !== episodeId || !root.isConnected) return;
    paintTaps();
    syncState();
    if (result?.sent) void livePaint();
  });

  const syncDone = () => {
    const done = !!pendingWatched(episodeId);
    doneBtn.textContent = done ? "✓…" : "✓";
    doneBtn.disabled = done;
  };
  doneBtn.addEventListener("click", () => {
    const n = pendingTapCount(episodeId);
    if (
      !confirm(
        "Finished this volume? Word exposures for the pages read are already credited; this marks it read. No Anki cards are made." +
          (n ? `\n\n${n} unsynced mark(s) will be sent first.` : ""),
      )
    )
      return;
    cancelTapSync(episodeId);
    if (n) submitTaps(episodeId);
    queueWatched(episodeId, false);
    syncDone();
    void flushOutbox().then(() => {
      paintTaps();
      syncState();
      syncDone();
    });
  });

  // --- page rendering ------------------------------------------------------------
  const current = (): MangaPage | null => doc?.pages[page] ?? null;
  const sizes = () => doc?.pages.map((p) => ({ w: p.w, h: p.h })) ?? [];

  /** The page (or strip) transform. In continuous mode this is also where
      scrolling lands: mount what the viewport now shows and track the page
      under its centre. */
  const applyView = () => {
    column.style.transform = `translate(${fit.x + view.tx}px, ${fit.y + view.ty}px) scale(${view.s})`;
    if (continuous) syncStrip();
  };

  /** Measure where the printed glyphs of every boxed line on a page are
      (manga-ink.ts), from the scan that just loaded. A canvas the webview
      won't let us read (or none at all — tests) measures nothing and the
      OCR boxes stand. */
  const measurePage = (im: HTMLImageElement, p: MangaPage): PageGlyphs => {
    const out: PageGlyphs = new Map();
    if (!im.naturalWidth || !im.naturalHeight) return out;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = im.naturalWidth;
      canvas.height = im.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return out;
      ctx.drawImage(im, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const scale = p.w ? im.naturalWidth / p.w : 1;
      p.blocks.forEach((b, bi) => {
        const lines = blockLines(b, sentences);
        if (!b.line_boxes || b.line_boxes.length !== lines.length) return;
        out.set(bi, b.line_boxes.map((box, li) => {
          const text = lines[li].map((fr) => fr.text).join("");
          return lineGlyphs(img, box, text, b.vertical, scale);
        }));
      });
    } catch {
      /* tainted canvas / no 2d context: the boxes will do */
    }
    return out;
  };

  /** Lay a page's bubbles over its art: one absolutely positioned block per
      bubble, one line element per printed line, token fragments as the
      tappable spans. Everything is sized at scale 1 (page px × f) — the
      column's transform scales it with the art. A bubble whose lines came
      with their own OCR boxes lays each line on its box (lineStyle), and
      once the scan has been measured each fragment sits on its own glyphs
      (manga-ink.ts); otherwise the lines share the bubble box across its
      writing axis. */
  const renderBlocks = (p: MangaPage, f: number, overlay: HTMLElement, glyphs?: PageGlyphs) => {
    overlay.textContent = "";
    p.blocks.forEach((b, bi) => {
      const st = blockStyle(b, f);
      const lines = blockLines(b, sentences);
      const boxes = b.line_boxes && b.line_boxes.length === lines.length ? b.line_boxes : null;
      const blk = el("div", `mg-block${st.vertical ? " v" : " h"}${boxes ? " lined" : ""}`);
      blk.style.left = `${st.left}px`;
      blk.style.top = `${st.top}px`;
      blk.style.width = `${st.width}px`;
      blk.style.height = `${st.height}px`;
      blk.style.fontSize = `${st.fontSize}px`;
      blk.style.lineHeight = `${st.lineSize}px`;
      const origin: [number, number] = [blockBox(b)[0], blockBox(b)[1]];
      const place = (n: HTMLElement, box: [number, number, number, number], chars: number, org: [number, number]) => {
        const ls = lineStyle(box, chars, b.vertical, f, org);
        n.style.left = `${ls.left}px`;
        n.style.top = `${ls.top}px`;
        n.style.width = `${ls.width}px`;
        n.style.height = `${ls.height}px`;
        n.style.fontSize = `${ls.fontSize}px`;
        n.style.lineHeight = `${b.vertical ? ls.width : ls.height}px`;
        n.style.letterSpacing = `${ls.letterSpacing}px`;
      };
      lines.forEach((line, li) => {
        const ln = el("p", "mg-line");
        const chars = line.reduce((n, fr) => n + fr.text.length, 0);
        const g = boxes ? glyphs?.get(bi)?.[li] : undefined;
        const measured = !!boxes && !!g && g.runs.length === chars;
        if (boxes) place(ln, boxes[li], chars, origin);
        if (measured) ln.classList.add("glyphs");
        const lineOrigin: [number, number] = boxes ? [boxes[li][0], boxes[li][1]] : origin;
        let c = 0; // characters of the line placed so far
        for (const fr of line) {
          const t = fr.token;
          const tappable = !!t.l && !NO_LOOKUP.test(t.l);
          const c0 = c;
          c += fr.text.length;
          if (!tappable && !measured) {
            ln.appendChild(document.createTextNode(fr.text));
            continue;
          }
          const n = el("span", tappable ? "w" : "mg-t", fr.text); // .w painted by paintTaps
          if (tappable) {
            n.dataset.lemma = t.l!;
            n.dataset.si = String(fr.si);
            n.dataset.ti = String(fr.ti);
          }
          // measured: the fragment sits on exactly its glyphs' ink
          if (measured) place(n, glyphSpanBox(g!, c0, c, b.vertical), fr.text.length, lineOrigin);
          ln.appendChild(n);
        }
        blk.appendChild(ln);
      });
      overlay.appendChild(blk);
    });
  };

  /** Re-lay every mounted page's bubbles (the paint or the transcript changed). */
  const renderOverlay = () => {
    if (!doc) return;
    for (const [i, m] of mounted) renderBlocks(doc.pages[i], m.f, m.overlay, glyphCache.get(i));
    paintTaps();
  };

  /** Put page i's box at a slot (size + position at scale 1); the overlay is
      re-laid when its scale changed. */
  const place = (i: number, m: Mounted, slot: Slot) => {
    m.box.style.left = `${slot.x}px`;
    m.box.style.top = `${slot.y}px`;
    m.box.style.width = `${slot.w}px`;
    m.box.style.height = `${slot.h}px`;
    if (m.f !== slot.f) {
      m.f = slot.f;
      renderBlocks(doc!.pages[i], slot.f, m.overlay, glyphCache.get(i));
      paintTaps(m.overlay);
    }
  };

  const mount = (i: number, slot: Slot) => {
    if (!doc) return;
    const p = doc.pages[i];
    const box = el("div", "mg-page");
    const im = document.createElement("img");
    im.className = "mg-img";
    im.draggable = false;
    const overlay = el("div", "mg-overlay");
    box.append(im, overlay);
    const m: Mounted = { box, img: im, overlay, f: NaN };
    mounted.set(i, m);
    place(i, m, slot);
    column.appendChild(box);
    im.addEventListener("load", () => {
      if (!mounted.get(i)) return;
      if (!p.w || !p.h) {
        // an OCR-less page: the scan is the first word on its size
        p.w = im.naturalWidth;
        p.h = im.naturalHeight;
        relayout();
      }
      // first sight of the scan: measure the lettering, then lay the
      // spans on the glyphs (once per page — the runs are in page px)
      if (!glyphCache.has(i) && p.blocks.some((b) => b.line_boxes)) {
        const g = measurePage(im, p);
        glyphCache.set(i, g);
        if (g.size && mounted.get(i) === m) {
          renderBlocks(p, m.f, m.overlay, g);
          paintTaps(m.overlay);
        }
      }
    });
    pageImageSrc(episodeId, p.file).then(
      (src) => {
        if (mounted.get(i) === m) im.src = src;
      },
      (e: Error) => {
        status.textContent = `⚠ page ${i + 1}: ${e.message}`;
      },
    );
  };

  const unmount = (i: number) => {
    const m = mounted.get(i);
    if (!m) return;
    mounted.delete(i);
    m.img.src = "";
    m.box.remove();
  };

  const unmountAll = () => {
    for (const i of [...mounted.keys()]) unmount(i);
  };

  /** Continuous mode: keep the pages within one viewport of the window
      mounted, nothing else; the page under the centre is the current one. */
  const syncStrip = () => {
    if (!strip || !doc) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const [from, to] = viewRange(view, fit, sw, sh, strip.vertical);
    const len = to - from;
    const want = slotsIn(strip, from - len, to + len);
    const keep = new Set(want.map((sl) => sl.i));
    for (const i of [...mounted.keys()]) if (!keep.has(i)) unmount(i);
    for (const sl of want) {
      const m = mounted.get(sl.i);
      if (m) place(sl.i, m, sl);
      else mount(sl.i, sl);
    }
    const centre = slotAt(strip, (from + to) / 2);
    if (centre !== page) setCurrent(centre);
  };

  /** Page i is the one being read: remembered for resume, timed for
      exposure credit, shown on the counter. */
  const setCurrent = (i: number) => {
    page = i;
    saveMangaPage(episodeId, i);
    recorder?.show(i);
    syncCounter();
  };

  /** Size the column for the mode and stage. Paged: the current page is
      mounted and the view applied. Continuous: the strip is measured only —
      the caller places the view (showPage / relayout) and applies it, so
      the page under the centre is never read off a stale position. */
  const layout = () => {
    if (!doc) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (continuous) {
      strip = stripLayout(sizes(), sw, sh, mode);
      fit = stripFit(strip, sw, sh);
      column.style.width = `${strip.w}px`;
      column.style.height = `${strip.h}px`;
      return;
    }
    strip = null;
    const p = current();
    if (!p) return;
    const pw = p.w || 1;
    const ph = p.h || 1;
    fit = fitPage(pw, ph, sw, sh);
    column.style.width = `${fit.w}px`;
    column.style.height = `${fit.h}px`;
    const slot: Slot = { i: page, x: 0, y: 0, w: fit.w, h: fit.h, f: fit.f };
    for (const i of [...mounted.keys()]) if (i !== page) unmount(i);
    const m = mounted.get(page);
    if (m) place(page, m, slot);
    else mount(page, slot);
    view = clampView(view, fit, sw, sh);
    applyView();
  };

  /** The geometry changed under the reader (stage resized, a page learned
      its size, the mode changed): lay out again and stay where the reader
      was — in continuous mode the same point of the same page stays under
      the stage's edge. */
  const relayout = (keepZoom = true) => {
    if (!doc) return;
    if (!keepZoom) view = { s: 1, tx: 0, ty: 0 };
    if (!continuous) {
      layout();
      return;
    }
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const frac = strip ? slotAnchor(strip, page, view, fit, sw, sh, mode) : 0;
    stopFling();
    layout();
    if (!strip) return;
    view = clampView(viewToSlot(strip, page, fit, view, view.s, sw, mode, frac), fit, sw, sh);
    applyView();
  };

  const preload = (i: number) => {
    const p = doc?.pages[i];
    if (!p || preloaded.has(i)) return;
    const im = new Image();
    void pageImageSrc(episodeId, p.file).then((src) => {
      im.src = src;
    });
    preloaded.set(i, im);
    for (const k of [...preloaded.keys()]) if (Math.abs(k - i) > 3) preloaded.delete(k);
  };

  const syncCounter = () => {
    if (!doc) return;
    counter.textContent = `${page + 1} / ${doc.page_count}`;
    slider.value = String(mode === "rtl" ? doc.page_count - 1 - page : page);
    titleEl.textContent = `${doc.series_title} · Vol. ${doc.vol_no}`;
  };

  /** Go to page i: in paged mode it becomes the page in the column; in
      continuous mode the strip scrolls so its reading-start edge meets the
      stage's. */
  const showPage = async (i: number, keepZoom = true) => {
    if (!doc) return;
    if (!doc.pages[i]) return;
    stopFling();
    if (continuous) {
      if (!strip) layout();
      if (!strip) return;
      const s = keepZoom ? view.s : 1;
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
      view = clampView(viewToSlot(strip, i, fit, keepZoom ? view : { s: 1, tx: 0, ty: 0 }, s, sw, mode), fit, sw, sh);
      applyView();
      if (page !== i) setCurrent(i);
      return;
    }
    popup.hide();
    if (!keepZoom) view = { s: 1, tx: 0, ty: 0 };
    else view = { s: view.s, tx: 0, ty: 0 }; // comicReader: zoom persists, pan resets
    setCurrent(i);
    layout();
    preload(i + 1);
    preload(i - 1);
  };

  const turn = (delta: 1 | -1) => {
    if (!doc) return;
    const j = turnPage(page, doc.page_count, delta);
    if (j == null) {
      status.textContent = delta > 0 ? "last page" : "first page";
      setTimeout(() => (status.textContent = ""), 900);
      return;
    }
    void showPage(j);
  };

  slider.addEventListener("input", () => {
    if (!doc) return;
    const v = Number(slider.value);
    void showPage(mode === "rtl" ? doc.page_count - 1 - v : v);
  });

  const syncMode = () => {
    root.classList.toggle("rtl", mode === "rtl");
    root.classList.toggle("continuous", continuous);
    modeBtn.textContent = MODE_LABEL[mode];
    scrollBtn.classList.toggle("on", continuous);
    syncCounter();
  };
  /** The mode or scrolling changed: rebuild the column on the same page at 1×. */
  const rebuild = () => {
    stopFling();
    popup.hide();
    unmountAll();
    strip = null;
    syncMode();
    void showPage(page, false);
  };
  modeBtn.addEventListener("click", () => {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    if (doc) setReadingMode(doc.slug, mode);
    rebuild();
  });
  scrollBtn.addEventListener("click", () => {
    continuous = !continuous;
    if (doc) setContinuousScroll(doc.slug, continuous);
    rebuild();
  });

  const toggleChrome = () => root.classList.toggle("chrome-hidden");

  // --- gestures --------------------------------------------------------------------
  // One pointer: tap (word → popup; zone → turn / chrome; double → zoom),
  // drag (pan when zoomed, else a swipe turns the page). Two pointers: pinch.
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: {
    startX: number;
    startY: number;
    t0: number;
    view0: View;
    moved: boolean;
    pinch0?: { d: number; s: number; cx: number; cy: number };
    trail: { t: number; x: number; y: number }[]; // recent finger positions (fling velocity)
    target: HTMLElement | null; // what the finger went down on (capture retargets the up)
  } | null = null;
  let lastTap: { x: number; y: number; t: number } | null = null;
  let tapTimer: number | undefined;

  // momentum: a pan (or the strip) keeps moving after the finger lifts
  let fling: number | undefined;
  const stopFling = () => {
    if (fling !== undefined) cancelAnimationFrame(fling);
    fling = undefined;
  };
  const startFling = (vx: number, vy: number) => {
    stopFling();
    const clip = (v: number) => Math.max(-FLING_MAX, Math.min(FLING_MAX, v));
    vx = clip(vx);
    vy = clip(vy);
    let last = performance.now();
    const step = (now: number) => {
      fling = undefined;
      const dt = Math.min(64, now - last);
      last = now;
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
      const want = { s: view.s, tx: view.tx + vx * dt, ty: view.ty + vy * dt };
      const next = clampView(want, fit, sw, sh);
      if (next.tx !== want.tx) vx = 0; // hit the bound
      if (next.ty !== want.ty) vy = 0;
      view = next;
      applyView();
      const k = Math.pow(FLING_DECAY, dt);
      vx *= k;
      vy *= k;
      if (Math.abs(vx) > FLING_STOP || Math.abs(vy) > FLING_STOP) fling = requestAnimationFrame(step);
    };
    fling = requestAnimationFrame(step);
  };
  /** Finger velocity (px/ms) over the last stretch of the drag. */
  const velocity = (trail: { t: number; x: number; y: number }[]) => {
    const now = trail[trail.length - 1];
    const ref = trail.find((p) => now.t - p.t <= 120) ?? trail[0];
    const dt = now.t - ref.t;
    return dt < 8 ? { vx: 0, vy: 0 } : { vx: (now.x - ref.x) / dt, vy: (now.y - ref.y) / dt };
  };

  const dist = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const mid = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const stagePoint = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  stage.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".gloss-pop")) return;
    const p = stagePoint(e);
    pointers.set(e.pointerId, p);
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      /* not a real pointer (tests) */
    }
    if (pointers.size === 1) {
      stopFling();
      gesture = { startX: p.x, startY: p.y, t0: Date.now(), view0: { ...view }, moved: false,
        trail: [{ t: performance.now(), x: p.x, y: p.y }],
        target: e.target as HTMLElement };
    } else if (pointers.size === 2 && gesture) {
      const m = mid();
      gesture.pinch0 = { d: dist(), s: view.s, cx: m.x, cy: m.y };
      gesture.moved = true;
    }
  });

  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    const p = stagePoint(e);
    pointers.set(e.pointerId, p);
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (pointers.size >= 2 && gesture.pinch0) {
      const m = mid();
      const s = (gesture.pinch0.s * dist()) / Math.max(1, gesture.pinch0.d);
      const z = zoomAbout(view, fit, Math.min(5, Math.max(1, s)), m.x, m.y);
      // the midpoint's travel pans too
      z.tx += m.x - gesture.pinch0.cx;
      z.ty += m.y - gesture.pinch0.cy;
      gesture.pinch0.cx = m.x;
      gesture.pinch0.cy = m.y;
      view = clampView(z, fit, sw, sh);
      applyView();
      return;
    }
    const dx = p.x - gesture.startX;
    const dy = p.y - gesture.startY;
    if (!gesture.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    gesture.moved = true;
    const trail = gesture.trail;
    trail.push({ t: performance.now(), x: p.x, y: p.y });
    while (trail.length > 2 && trail[trail.length - 1].t - trail[0].t > 160) trail.shift();
    if (continuous || view.s > 1.01) {
      // the strip scrolls / a zoomed page pans with the finger, within bounds
      view = clampView({ s: view.s, tx: gesture.view0.tx + dx, ty: gesture.view0.ty + dy }, fit, sw, sh);
      applyView();
    } else {
      // at 1× the page rides with the finger along the reading axis (a swipe
      // in the making); it springs back or turns when the finger lifts
      const slideX = mode === "vertical" ? 0 : dx;
      const slideY = mode === "vertical" ? dy : 0;
      column.style.transform = `translate(${fit.x + slideX}px, ${fit.y + slideY}px) scale(1)`;
    }
  });

  /** Animate the column back to the view (an uncommitted swipe). */
  const snapBack = () => {
    column.style.transition = `transform ${SNAP_MS}ms ease-out`;
    applyView();
    window.setTimeout(() => (column.style.transition = ""), SNAP_MS);
  };

  const endGesture = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    try {
      stage.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (pointers.size > 0) {
      // a pinch finger lifted: the remaining finger continues as a pan
      if (gesture) {
        const [rest] = [...pointers.values()];
        gesture.startX = rest.x;
        gesture.startY = rest.y;
        gesture.view0 = { ...view };
        gesture.pinch0 = undefined;
      }
      return;
    }
    const g = gesture;
    gesture = null;
    if (!g) return;
    const p = stagePoint(e);
    const dx = p.x - g.startX;
    const dy = p.y - g.startY;
    const dt = Date.now() - g.t0;
    if (!g.moved && dt < TAP_MS * 2) {
      onTap(g.target, p);
      return;
    }
    if (continuous || view.s > 1.01) {
      // a pan keeps its momentum — but only from a finger still moving as it lifted
      if (g.pinch0 || performance.now() - g.trail[g.trail.length - 1].t > 100) return;
      const { vx, vy } = velocity(g.trail);
      if (Math.abs(vx) > FLING_STOP || Math.abs(vy) > FLING_STOP) startFling(vx, vy);
      return;
    }
    const t = swipeTurnFor(dx, dy, mode, SWIPE_PX);
    if (t && turnPage(page, doc?.page_count ?? 0, t) != null) turn(t);
    else snapBack();
  };
  stage.addEventListener("pointerup", endGesture);
  stage.addEventListener("pointercancel", endGesture);

  const onTap = (target: HTMLElement | null, p: { x: number; y: number }) => {
    const w = target?.closest<HTMLElement>(".w[data-lemma]") ?? null;
    if (w) {
      // a word: immediate — no double-tap wait on the thing people tap most
      lastTap = null;
      const si = Number(w.dataset.si);
      const ti = Number(w.dataset.ti);
      const sentence = sentences[si] as PopupSentence | undefined;
      popup.show(w.dataset.lemma!, Number.isFinite(ti) ? ti : undefined, sentence);
      return;
    }
    if (popup.visible) {
      popup.hide();
      return;
    }
    const now = Date.now();
    if (lastTap && now - lastTap.t < TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
      // double tap: 1× ↔ 2× about the finger
      lastTap = null;
      if (tapTimer) clearTimeout(tapTimer);
      const target = view.s > 1.01 ? 1 : DOUBLE_TAP_SCALE;
      stopFling();
      view = clampView(zoomAbout(view, fit, target, p.x, p.y), fit, stage.clientWidth, stage.clientHeight);
      applyView();
      return;
    }
    lastTap = { x: p.x, y: p.y, t: now };
    tapTimer = window.setTimeout(() => {
      lastTap = null;
      // a zoomed page only pans, and a continuous strip is only ever
      // scrolled — a tap on either just shows / hides the chrome
      if (continuous || view.s > 1.01) {
        toggleChrome();
        return;
      }
      const zone = tapZoneFor(p.x, p.y, stage.clientWidth, stage.clientHeight, mode);
      if (zone === "center") toggleChrome();
      else turn(zone === "next" ? 1 : -1);
    }, TAP_MS);
  };

  // --- lifecycle -----------------------------------------------------------------
  const onResize = () => relayout();
  window.addEventListener("resize", onResize);
  const onVisibility = () => {
    if (document.hidden) recorder?.pause();
    else recorder?.resume();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const cleanup = () => {
    recorder?.close();
    recorder = null;
    void flushOutbox();
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onVisibility);
    if (tapTimer) clearTimeout(tapTimer);
    stopFling();
  };
  window.addEventListener("hashchange", cleanup, { once: true });

  void (async () => {
    try {
      let rec = getMangaRecord(episodeId);
      if (!isComplete(rec)) {
        status.textContent = "downloading volume…";
        rec = await downloadManga(episodeId, (done, total) => {
          status.textContent = `downloading pages ${done}/${total}`;
        });
      }
      doc = await loadLocalManga(episodeId);
      const transcript = await loadLocalMangaTranscript(episodeId);
      sentences = transcript?.sentences ?? [];
      const paint = getCachedPaint(episodeId);
      applyPaintKnown(sentences, paint);
      snapshot = transcript ?? {};
      lists = listsFor(paint, snapshot);
      highValue = new Set(transcript?.candidates ?? []);
      defs = (await loadLocalMangaDefinitions(episodeId)) ?? {};
      if (!doc || !doc.pages.length) throw new Error("volume bundle incomplete — re-download");
      mode = readingMode(doc.slug, doc.reading === "ltr" ? "ltr" : "rtl");
      continuous = continuousScroll(doc.slug);
      slider.max = String(doc.page_count - 1);
      syncMode();
      recorder = new ReadRecorder({
        episodeId,
        title: doc.title,
        pageSecs: doc.page_secs || 30,
        pageCount: doc.page_count,
      });
      status.textContent = "";
      const resume = getMangaPage(episodeId);
      page = resume != null && resume < doc.page_count ? resume : 0;
      await showPage(page, false);
      syncState();
      syncDone();
      if (pendingTapCount(episodeId)) scheduleTapSync(episodeId);
      void livePaint();
      if (!rec?.curated) {
        void refreshMangaSidecars(episodeId).then(async (fresh) => {
          if (!fresh || !root.isConnected) return;
          doc = (await loadLocalManga(episodeId)) ?? doc; // bubbles rebuilt by the AI read
          sentences = fresh.sentences;
          const st = getCachedPaint(episodeId);
          applyPaintKnown(sentences, st);
          snapshot = fresh;
          lists = listsFor(st, snapshot);
          highValue = new Set(fresh.candidates ?? []);
          defs = (await loadLocalMangaDefinitions(episodeId)) ?? defs;
          if (doc) slider.max = String(doc.page_count - 1);
          relayout(); // page sizes / bubbles may have changed with the read
          renderOverlay();
        });
      }
    } catch (e) {
      status.textContent = `⚠ ${(e as Error).message}`;
    }
  })();

  return root;
}
