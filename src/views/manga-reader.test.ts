// DOM smoke tests for the manga reader: the bundle renders as an overlay of
// tappable spans laid into the printed lines, a tap on a word opens the
// popup + a mark paints, tap zones turn pages in reading order, and leaving
// records the sitting with page-span ranges.

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
      { box: [100, 100, 300, 160], vertical: false, font_size: 24, lines: [4], sents: [1] },
    ] },
    { n: 2, file: "003.jpg", w: 800, h: 1200, blocks: [] },
  ],
};
const TRANSCRIPT: TranscriptDoc = {
  episode_id: "manga_t_v01",
  curated: true,
  sentences: [
    { idx: 0, start: 0, end: 0.1, tokens: [
      { s: "犬", l: "犬", r: "いぬ", c: 1, k: 1 }, { s: "が", l: "が" },
      { s: "走る", l: "走る", r: "はしる", c: 1, k: 0 }, { s: "。" }] },
    { idx: 1, start: 30, end: 30.1, tokens: [{ s: "公園", l: "公園", c: 1 }, { s: "へ", l: "へ" }, { s: "。" }] },
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

async function mount() {
  localStorage.clear();
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
    const words = [...block.querySelectorAll<HTMLElement>(".w")].map((w) => [w.dataset.lemma, w.textContent, w.classList.contains("unk")]);
    // 走る wraps: two spans with the same lemma; 犬 is known (no wash), 走る unknown
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
