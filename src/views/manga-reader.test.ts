// DOM smoke tests for the manga reader: the bundle renders as an overlay of
// tappable spans laid into the printed lines, a tap on a word opens the
// popup + a mark paints, tap zones turn pages in reading order, and leaving
// records the sitting with page-span ranges. The washes are the player's
// paints (highlight.ts): tiers, high-value candidates, phrase spans and
// grammar units painted from their own state.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MangaDoc, TranscriptDoc } from "../types";

const DOC: MangaDoc = {
  episode_id: "manga_t_v01", slug: "t", title: "T Vol. 1", series_title: "T", vol_no: 1,
  reading: "rtl", page_secs: 30, page_count: 3,
  pages: [
    { n: 0, file: "001.jpg", w: 800, h: 1200, blocks: [
      { box: [500, 100, 600, 400], vertical: true, font_size: 24, lines: [3, 2], sents: [0] },
    ] },
    { n: 1, file: "002.jpg", w: 800, h: 1200, blocks: [
      { box: [100, 100, 300, 160], vertical: false, font_size: 24, lines: [6], sents: [1] },
      // a bubble with per-line OCR boxes: two columns, read right to left
      { box: [500, 200, 600, 500], vertical: true, font_size: 30, lines: [3, 1], sents: [3],
        line_boxes: [[560, 200, 600, 440], [500, 210, 540, 370]] },
    ] },
    { n: 2, file: "003.jpg", w: 800, h: 1200, blocks: [
      { box: [100, 100, 300, 160], vertical: false, font_size: 24, lines: [7], sents: [2] },
    ] },
  ],
};
const TRANSCRIPT: TranscriptDoc = {
  episode_id: "manga_t_v01",
  curated: true,
  candidates: ["公園"],
  sentences: [
    { idx: 0, start: 0, end: 0.1, tokens: [
      { s: "犬", l: "犬", r: "いぬ", c: 1, k: 1 }, { s: "が", l: "が" },
      { s: "走る", l: "走る", r: "はしる", c: 1, k: 0 }, { s: "。" }] },
    // two unknowns (no i+1 target): 公園 is a ranked candidate, 行く is not
    { idx: 1, start: 30, end: 30.1, tokens: [
      { s: "公園", l: "公園", c: 1 }, { s: "へ", l: "へ" }, { s: "行く", l: "行く", c: 1 }, { s: "。" }] },
    // 血が騒ぐ: every word known, the phrase not; 〜てしまう on 食べてしまった
    { idx: 2, start: 60, end: 60.1,
      tokens: [
        { s: "血", l: "血", c: 1, k: 1 }, { s: "が", l: "が" }, { s: "騒ぐ", l: "騒ぐ", c: 1, k: 1 },
        { s: "食べ", l: "食べる", c: 1, k: 1 }, { s: "て", l: "て" }, { s: "しまっ", l: "しまう" }, { s: "た", l: "た" }],
      phrases: [{ canonical: "血が騒ぐ", start: 0, end: 3, status: "unknown" }],
      grammar: [{ pattern: "〜てしまう", start: 4, end: 6, status: "unknown" }] },
    { idx: 3, start: 30.1, end: 30.2, tokens: [
      { s: "猫", l: "猫", c: 1, k: 1 }, { s: "が", l: "が" }, { s: "来た", l: "来る", c: 1, k: 1 }] },
  ],
} as unknown as TranscriptDoc;

vi.mock("../manga", async (importOriginal) => {
  const real = await importOriginal<typeof import("../manga")>();
  return {
    ...real,
    getMangaRecord: () => ({ docPath: "d", transcriptPath: "t", pagesDir: "p", pageCount: 3,
      pagesDownloaded: 3, curated: true, at: "" }),
    isComplete: () => true,
    loadLocalManga: async () => DOC,
    loadLocalMangaTranscript: async () => TRANSCRIPT,
    loadLocalMangaDefinitions: async () => ({ 走る: [{ k: ["走る"], r: ["はしる"], s: [{ pos: ["v5r"], g: ["to run"] }] }] }),
    pageImageSrc: async (_ep: string, file: string) => `data:${file}`,
    refreshMangaSidecars: async () => null,
  };
});
vi.mock("../paint", async (importOriginal) => {
  const real = await importOriginal<typeof import("../paint")>();
  return { ...real, fetchPaint: async () => null };
});

import { mangaReaderView } from "./manga-reader";
import { getTaps, getViewLog } from "../store";

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

function size(el: HTMLElement, w: number, h: number) {
  Object.defineProperty(el, "clientWidth", { value: w, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: h, configurable: true });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

function pointer(target: Element, type: string, x: number, y: number, id = 1) {
  const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }) as MouseEvent & { pointerId: number };
  Object.defineProperty(ev, "pointerId", { value: id });
  target.dispatchEvent(ev);
}

async function tap(target: Element, x: number, y: number) {
  pointer(target, "pointerdown", x, y);
  pointer(target, "pointerup", x, y);
  await new Promise((r) => setTimeout(r, 320)); // past the double-tap window
}

async function mount(before?: () => void) {
  localStorage.clear();
  before?.();
  const view = mangaReaderView("manga_t_v01");
  document.body.appendChild(view);
  const stage = view.querySelector<HTMLElement>(".mg-stage")!;
  size(stage, 400, 800);
  await settle();
  return { view, stage };
}

describe("manga reader", () => {
  beforeEach(() => {
    window.dispatchEvent(new Event("hashchange")); // tear down the previous test's reader
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("renders the bubble as printed lines of tappable spans over the page", async () => {
    const { view } = await mount();
    expect(view.querySelector<HTMLImageElement>(".mg-img")!.src).toContain("001.jpg");
    const block = view.querySelector<HTMLElement>(".mg-block")!;
    expect(block.classList.contains("v")).toBe(true);
    // box 500..600 × 100..400 at fit 0.5 → 50px wide at 250, 150 tall
    expect(block.style.left).toBe("250px");
    expect(block.style.width).toBe("50px");
    const lines = [...block.querySelectorAll(".mg-line")].map((l) => l.textContent);
    expect(lines).toEqual(["犬が走", "る。"]);
    const words = [...block.querySelectorAll<HTMLElement>(".w")].map((w) => [w.dataset.lemma, w.textContent, w.classList.contains("hl-target")]);
    // 走る wraps: two spans with the same lemma; 犬 is known (no wash), 走る is
    // the line's one unknown — the i+1 target, like the player's
    expect(words).toEqual([["犬", "犬", false], ["が", "が", false], ["走る", "走", true], ["走る", "る", true]]);
    expect(view.querySelector(".mg-counter")!.textContent).toBe("1 / 3");
  });

  it("a tap on a word opens the popup and a mark paints every fragment", async () => {
    const { view, stage } = await mount();
    const frag = view.querySelector<HTMLElement>('.w[data-lemma="走る"]')!;
    pointer(frag, "pointerdown", 260, 120);
    pointer(frag, "pointerup", 260, 120);
    const pop = view.querySelector<HTMLElement>(".gloss-pop")!;
    expect(pop.style.display).not.toBe("none");
    expect(pop.textContent).toContain("to run");
    pop.querySelector<HTMLButtonElement>(".gp-mark")!.click();
    expect(getTaps("manga_t_v01")["走る"]).toBe("k");
    const painted = [...view.querySelectorAll('.w[data-lemma="走る"]')].map((w) => w.classList.contains("tap-k"));
    expect(painted).toEqual([true, true]);
    expect(stage.querySelector(".mg-img")).not.toBeNull();
  });

  it("tap zones turn pages in reading order (RTL: left = forward)", async () => {
    const { view, stage } = await mount();
    await tap(stage, 20, 400); // left third → next
    expect(view.querySelector(".mg-counter")!.textContent).toBe("2 / 3");
    expect(view.querySelector<HTMLElement>(".mg-block")!.classList.contains("h")).toBe(true);
    await tap(stage, 380, 400); // right third → back
    expect(view.querySelector(".mg-counter")!.textContent).toBe("1 / 3");
    await tap(stage, 380, 400); // already first
    expect(view.querySelector(".mg-counter")!.textContent).toBe("1 / 3");
    expect(view.classList.contains("chrome-hidden")).toBe(false);
    await tap(stage, 200, 400); // centre → chrome
    expect(view.classList.contains("chrome-hidden")).toBe(true);
    expect(localStorage.getItem("fp.mpage.manga_t_v01")).toBe("0");
  });

  it("lays a bubble's lines on their own OCR boxes, glyphs at the printed pitch", async () => {
    const { view, stage } = await mount();
    await tap(stage, 20, 400); // page 2
    const blk = view.querySelector<HTMLElement>(".mg-block.lined")!;
    expect(blk).not.toBeNull();
    // the block is the union of its line boxes at fit 0.5 (x 500..600,
    // y 200..440), not mokuro's bubble box
    expect([blk.style.left, blk.style.top, blk.style.width, blk.style.height]).toEqual(["250px", "100px", "50px", "120px"]);
    const lines = [...blk.querySelectorAll<HTMLElement>(".mg-line")];
    expect(lines.map((l) => l.textContent)).toEqual(["猫が来", "た"]);
    // first column: 40 wide × 240 tall → 20×120 css px at (30, 0) in the block;
    // 3 glyphs over 120px = 40px pitch, glyph capped to the 20px column width
    expect([lines[0].style.left, lines[0].style.top, lines[0].style.width, lines[0].style.height]).toEqual(["30px", "0px", "20px", "120px"]);
    expect(lines[0].style.fontSize).toBe("20px");
    expect(lines[0].style.letterSpacing).toBe("20px");
    // second column sits at its own box, not an even share of the bubble
    expect([lines[1].style.left, lines[1].style.top]).toEqual(["0px", "5px"]);
    // the other bubble on the page has no line boxes → the shared layout
    expect(view.querySelector(".mg-block:not(.lined)")).not.toBeNull();
  });

  it("continuous scrolling: a tap never turns the page, it toggles the chrome", async () => {
    const { view, stage } = await mount(() => localStorage.setItem("fp.mreader.scroll", "on"));
    expect(view.classList.contains("continuous")).toBe(true);
    expect(view.querySelector(".mg-counter")!.textContent).toBe("1 / 3");
    await tap(stage, 20, 400); // the paged "next" zone
    expect(view.querySelector(".mg-counter")!.textContent).toBe("1 / 3");
    expect(view.classList.contains("chrome-hidden")).toBe(true);
    await tap(stage, 380, 400);
    expect(view.classList.contains("chrome-hidden")).toBe(false);
  });

  it("paints the player's tiers: the ◨ button cycles off / focus / learn", async () => {
    const { view, stage } = await mount();
    const btn = view.querySelector<HTMLButtonElement>(".mg-tier")!;
    expect(btn.textContent).toBe("◨ learn"); // the player's default
    const cls = (lemma: string) => view.querySelector<HTMLElement>(`.w[data-lemma="${lemma}"]`)!.className;
    expect(cls("走る")).toContain("hl-target");
    btn.click(); // off: nothing painted
    expect(btn.textContent).toBe("◨ off");
    expect(localStorage.getItem("fp.manga.hl")).toBe("off");
    expect(cls("走る")).toBe("w");
    btn.click(); // focus: the target still paints, a plain unknown would not
    expect(btn.textContent).toBe("◨ focus");
    expect(cls("走る")).toContain("hl-target");
    await tap(stage, 20, 400); // page 2: 公園 is a ranked candidate → high value (pink)
    expect(cls("公園")).toContain("hl-hv");
    expect(cls("行く")).toBe("w"); // a plain unknown waits for the learn tier
    btn.click(); // learn: every unknown
    expect(cls("公園")).toContain("hl-hv");
    expect(cls("行く")).toContain("hl-unk");
  });

  it("a phrase span and a grammar unit paint from their own state, not their words'", async () => {
    const { view, stage } = await mount();
    await tap(stage, 20, 400);
    await tap(stage, 20, 400); // page 3
    const spans = [...view.querySelectorAll<HTMLElement>(".mg-block .w")];
    const by = (text: string) => spans.find((w) => w.textContent === text)!;
    // 血 / が / 騒ぐ are all known, but the phrase 血が騒ぐ is not: the whole
    // span washes unknown as one unit (the player's rule)
    for (const t of ["血", "が", "騒ぐ"]) {
      expect(by(t).classList.contains("hl-unk")).toBe(true);
      expect(by(t).dataset.phrase).toBe("血が騒ぐ");
    }
    // 食べ is known and unpainted; て / しまっ belong to 〜てしまう (unknown):
    // orange with the attachment marker
    expect(by("食べ").className).toBe("w");
    for (const t of ["て", "しまっ"]) {
      expect(by(t).classList.contains("hl-unk")).toBe(true);
      expect(by(t).classList.contains("gr")).toBe(true);
      expect(by(t).dataset.grammar).toBe("〜てしまう");
    }
    // a ✓ on the phrase clears its span; the words never changed
    pointer(by("血"), "pointerdown", 150, 130);
    pointer(by("血"), "pointerup", 150, 130);
    const pop = view.querySelector<HTMLElement>(".gloss-pop")!;
    const layer = pop.querySelector<HTMLElement>('[data-phrase="血が騒ぐ"]')!;
    expect(layer).not.toBeNull();
    layer.querySelector<HTMLButtonElement>(".gp-mark")!.click();
    expect(getTaps("manga_t_v01")["p:血が騒ぐ"]).toBe("k");
    for (const t of ["血", "が", "騒ぐ"]) {
      expect(by(t).classList.contains("hl-unk")).toBe(false);
      expect(by(t).classList.contains("tap-k")).toBe(true);
    }
  });

  it("leaving records the pages read as a sitting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { stage } = await mount();
      vi.advanceTimersByTime(5000);
      pointer(stage, "pointerdown", 20, 400);
      pointer(stage, "pointerup", 20, 400);
      await new Promise((r) => setTimeout(r, 320));
      vi.advanceTimersByTime(8000);
      window.dispatchEvent(new Event("hashchange"));
      const seg = getViewLog()[0];
      expect(seg.episode_id).toBe("manga_t_v01");
      expect(seg.kind).toBe("read");
      expect(seg.played).toEqual([[0, 60]]);
      expect(seg.secs).toBeCloseTo(13, 0);
    } finally {
      vi.useRealTimers();
    }
  });
});
