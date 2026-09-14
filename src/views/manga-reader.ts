// Manga reader (#/manga/<id>): one volume from the PC library, page by page,
// with the same tap-a-word machinery as the player and the 5ch reader laid
// invisibly over the art. The PC's OCR (tools.manga) gives every speech
// bubble a box and its printed lines; the transcript gives the tokens; the
// overlay lays the tokens back into the lines (manga-layout.ts blockLines)
// as transparent spans, so the colour washes (unknown / think-you-know /
// ★ / should-know) sit on the printed words and a tap on a word opens the
// shared gloss popup with the shared mark cycle — marks sync live as normal
// tap batches, lookups are recorded, all under encounter mode "manga".
//
// Reading behaviours follow the comicReader app: right-to-left page order
// by default (per-series toggle), tap zones (far side turns forward, centre
// toggles the chrome), swipe to turn, pinch 1–5× and double-tap 1↔2× about
// the finger, zoom kept across page turns, a pull past the edge of a zoomed
// page turning it, spreads fit to width, resume at the last page. Time on
// each page becomes a viewtime sitting whose played ranges are page spans
// (manga.ts ReadRecorder) — the exposure credit is exactly the pages read.

import { createGlossPopup } from "../gloss-popup";
import type { PopupSentence } from "../gloss-popup";
import { cancelTapSync, onTapSync, scheduleTapSync } from "../livesync";
import {
  blockLines,
  blockStyle,
  clampView,
  DOUBLE_TAP_SCALE,
  fitPage,
  swipeTurn,
  tapZone,
  turnPage,
  zoomAbout,
} from "../manga-layout";
import type { Fit, View } from "../manga-layout";
import {
  downloadManga,
  getMangaPage,
  getMangaRecord,
  isComplete,
  loadLocalManga,
  loadLocalMangaDefinitions,
  loadLocalMangaTranscript,
  pageImageSrc,
  readingDirection,
  ReadRecorder,
  refreshMangaSidecars,
  saveMangaPage,
  setReadingDirection,
} from "../manga";
import type { ReadingDirection } from "../manga";
import {
  applyPaintKnown,
  fetchPaint,
  getCachedPaint,
  grammarListsFor,
  listClass,
  listsFor,
  lookupListOf,
  NO_LISTS,
  paintsInterest,
  phraseListsFor,
  sameLists,
} from "../paint";
import type { ListSnapshot, PaintLists } from "../paint";
import { NO_LOOKUP } from "../prep-render";
import {
  getOutbox,
  getSubmitted,
  getTaps,
  pendingTapCount,
  pendingWatched,
  queueWatched,
  submitTaps,
} from "../store";
import { flushOutbox } from "../sync";
import type { Definitions, MangaDoc, MangaPage, TranscriptDoc, TranscriptSentence } from "../types";

const HL_KEY = "fp.manga.hl"; // "off" = washes hidden
const TEXT_KEY = "fp.manga.text"; // "on" = OCR text shown (checking the read)
const TAP_MS = 300; // max press for a tap; double-tap window
const TAP_SLOP = 10; // px of movement that still counts as a tap
const SWIPE_PX = 60; // horizontal travel that turns a page at 1×
const EDGE_PULL_PX = 70; // pull past a zoomed page's edge that turns it

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function mangaReaderView(episodeId: string): HTMLElement {
  const root = el("div", "view manga-view");
  const stage = el("div", "mg-stage");
  const pageBox = el("div", "mg-page");
  const img = document.createElement("img");
  img.className = "mg-img";
  img.draggable = false;
  const overlay = el("div", "mg-overlay");
  pageBox.append(img, overlay);
  stage.appendChild(pageBox);
  const status = el("div", "mg-status");
  stage.appendChild(status);

  // --- chrome ------------------------------------------------------------------
  const top = el("div", "mg-bar mg-top");
  const back = el("a", "mg-btn", "‹") as HTMLAnchorElement;
  back.href = "#/pages";
  const titleEl = el("div", "mg-title");
  const hlBtn = el("button", "mg-btn", "◨") as HTMLButtonElement;
  hlBtn.title = "highlights";
  const textBtn = el("button", "mg-btn", "T") as HTMLButtonElement;
  textBtn.title = "show OCR text";
  const dirBtn = el("button", "mg-btn", "⇄") as HTMLButtonElement;
  dirBtn.title = "reading direction";
  const syncEl = el("span", "mg-sync");
  const doneBtn = el("button", "mg-btn mg-done", "✓") as HTMLButtonElement;
  doneBtn.title = "finished reading";
  top.append(back, titleEl, syncEl, hlBtn, textBtn, dirBtn, doneBtn);
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
    const off = localStorage.getItem(HL_KEY) === "off";
    root.classList.toggle("no-hl", off);
    hlBtn.classList.toggle("on", !off);
  };
  hlBtn.addEventListener("click", () => {
    localStorage.setItem(HL_KEY, root.classList.contains("no-hl") ? "on" : "off");
    syncHl();
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
  let snapshot: ListSnapshot & Pick<TranscriptDoc, "grammar_points"> = {};
  let defs: Definitions = {};
  let dir: ReadingDirection = "rtl";
  let page = 0;
  let fit: Fit = { w: 0, h: 0, x: 0, y: 0, f: 1 };
  let view: View = { s: 1, tx: 0, ty: 0 };
  let recorder: ReadRecorder | null = null;
  const preloaded = new Map<number, HTMLImageElement>();

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
  const paintTaps = () => {
    const taps = getTaps(episodeId);
    const submitted = getSubmitted(episodeId);
    lists = listsFor(getCachedPaint(episodeId), snapshot);
    overlay.querySelectorAll<HTMLElement>(".w[data-lemma]").forEach((w) => {
      const lemma = w.dataset.lemma!;
      const mark = taps[lemma];
      const lc = listClass(lemma, lists);
      w.classList.toggle("hl-know", lc === "hl-know");
      w.classList.toggle("hl-int", lc === "hl-int");
      w.classList.toggle("hl-sk", lc === "hl-sk");
      w.classList.toggle("tap-k", mark === "k");
      w.classList.toggle("tap-h", paintsInterest(mark, lemma, lists.interest));
      w.classList.toggle("tap-u", mark === "u");
      w.classList.toggle("tap-committed", mark !== undefined && submitted[lemma] === mark);
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

  const applyView = () => {
    pageBox.style.transform = `translate(${fit.x + view.tx}px, ${fit.y + view.ty}px) scale(${view.s})`;
  };

  const layout = () => {
    const p = current();
    if (!p) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const pw = p.w || img.naturalWidth || 1;
    const ph = p.h || img.naturalHeight || 1;
    fit = fitPage(pw, ph, sw, sh);
    pageBox.style.width = `${fit.w}px`;
    pageBox.style.height = `${fit.h}px`;
    view = clampView(view, fit, sw, sh);
    applyView();
    renderOverlay();
  };

  /** Lay the page's bubbles over the art: one absolutely positioned block
      per bubble, one line element per printed line, token fragments as the
      tappable spans. Everything is sized at scale 1 — the page box's
      transform scales it with the art. */
  const renderOverlay = () => {
    const p = current();
    overlay.textContent = "";
    if (!p) return;
    for (const b of p.blocks) {
      const st = blockStyle(b, fit.f);
      const blk = el("div", `mg-block${st.vertical ? " v" : " h"}`);
      blk.style.left = `${st.left}px`;
      blk.style.top = `${st.top}px`;
      blk.style.width = `${st.width}px`;
      blk.style.height = `${st.height}px`;
      blk.style.fontSize = `${st.fontSize}px`;
      blk.style.lineHeight = `${st.lineSize}px`;
      for (const line of blockLines(b, sentences)) {
        const ln = el("p", "mg-line");
        for (const f of line) {
          const t = f.token;
          const tappable = !!t.l && !NO_LOOKUP.test(t.l);
          if (!tappable) {
            ln.appendChild(document.createTextNode(f.text));
            continue;
          }
          const n = el("span", `w${t.c && !t.k ? " unk" : ""}`, f.text);
          n.dataset.lemma = t.l!;
          n.dataset.si = String(f.si);
          n.dataset.ti = String(f.ti);
          const lc = listClass(t.l, lists);
          if (lc) n.classList.add(lc);
          ln.appendChild(n);
        }
        blk.appendChild(ln);
      }
      overlay.appendChild(blk);
    }
    paintTaps();
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
    slider.value = String(dir === "rtl" ? doc.page_count - 1 - page : page);
    titleEl.textContent = `${doc.series_title} · Vol. ${doc.vol_no}`;
  };

  const showPage = async (i: number, keepZoom = true) => {
    if (!doc) return;
    const p = doc.pages[i];
    if (!p) return;
    page = i;
    popup.hide();
    saveMangaPage(episodeId, i);
    recorder?.show(i);
    if (!keepZoom) view = { s: 1, tx: 0, ty: 0 };
    else view = { s: view.s, tx: 0, ty: 0 }; // comicReader: zoom persists, pan resets
    overlay.textContent = "";
    try {
      img.src = await pageImageSrc(episodeId, p.file);
    } catch (e) {
      status.textContent = `⚠ page ${i + 1}: ${(e as Error).message}`;
    }
    layout();
    syncCounter();
    preload(i + 1);
    preload(i - 1);
  };
  img.addEventListener("load", () => {
    const p = current();
    if (p && (!p.w || !p.h)) layout(); // an OCR-less page: size from the image
  });

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
    void showPage(dir === "rtl" ? doc.page_count - 1 - v : v);
  });

  const syncDir = () => {
    root.classList.toggle("rtl", dir === "rtl");
    dirBtn.textContent = dir === "rtl" ? "⇄ 右→左" : "⇄ L→R";
    syncCounter();
  };
  dirBtn.addEventListener("click", () => {
    dir = dir === "rtl" ? "ltr" : "rtl";
    if (doc) setReadingDirection(doc.slug, dir);
    syncDir();
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
    edgeDx: number;
    target: HTMLElement | null; // what the finger went down on (capture retargets the up)
  } | null = null;
  let lastTap: { x: number; y: number; t: number } | null = null;
  let tapTimer: number | undefined;

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
      gesture = { startX: p.x, startY: p.y, t0: Date.now(), view0: { ...view }, moved: false,
        edgeDx: 0, target: e.target as HTMLElement };
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
    if (view.s > 1.01) {
      const want = { s: view.s, tx: gesture.view0.tx + dx, ty: gesture.view0.ty + dy };
      view = clampView(want, fit, sw, sh);
      // how far the finger pulled past the horizontal bound
      gesture.edgeDx = want.tx - view.tx;
      applyView();
    } else {
      // at 1× the page slides with the finger a little (feedback), then snaps
      pageBox.style.transform = `translate(${fit.x + dx * 0.35}px, ${fit.y}px) scale(1)`;
    }
  });

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
    const dt = Date.now() - g.t0;
    if (!g.moved && dt < TAP_MS * 2) {
      onTap(g.target, p);
      return;
    }
    if (view.s > 1.01) {
      if (Math.abs(g.edgeDx) > EDGE_PULL_PX) turn(swipeTurn(g.edgeDx, dir));
      return;
    }
    applyView(); // snap back
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(p.y - g.startY)) turn(swipeTurn(dx, dir));
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
      view = clampView(zoomAbout(view, fit, target, p.x, p.y), fit, stage.clientWidth, stage.clientHeight);
      applyView();
      return;
    }
    lastTap = { x: p.x, y: p.y, t: now };
    tapTimer = window.setTimeout(() => {
      lastTap = null;
      if (view.s > 1.01) {
        toggleChrome();
        return;
      }
      const zone = tapZone(p.x, stage.clientWidth, dir);
      if (zone === "center") toggleChrome();
      else turn(zone === "next" ? 1 : -1);
    }, TAP_MS);
  };

  // --- lifecycle -----------------------------------------------------------------
  const onResize = () => layout();
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
      defs = (await loadLocalMangaDefinitions(episodeId)) ?? {};
      if (!doc || !doc.pages.length) throw new Error("volume bundle incomplete — re-download");
      dir = readingDirection(doc.slug, doc.reading === "ltr" ? "ltr" : "rtl");
      slider.max = String(doc.page_count - 1);
      syncDir();
      recorder = new ReadRecorder({
        episodeId,
        title: doc.title,
        pageSecs: doc.page_secs || 30,
        pageCount: doc.page_count,
      });
      status.textContent = "";
      const resume = getMangaPage(episodeId);
      await showPage(resume != null && resume < doc.page_count ? resume : 0, false);
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
          defs = (await loadLocalMangaDefinitions(episodeId)) ?? defs;
          if (doc) slider.max = String(doc.page_count - 1);
          renderOverlay();
        });
      }
    } catch (e) {
      status.textContent = `⚠ ${(e as Error).message}`;
    }
  })();

  return root;
}
