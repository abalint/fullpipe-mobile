import { describe, expect, it } from "vitest";
import {
  blockLines,
  blockStyle,
  clampView,
  fitPage,
  swipeTurn,
  tapZone,
  turnPage,
  zoomAbout,
} from "./manga-layout";
import type { MangaBlock, TranscriptSentence } from "./types";

describe("fitPage", () => {
  it("fits a portrait page inside the stage, centred", () => {
    const fit = fitPage(764, 1200, 400, 800);
    expect(fit.f).toBeCloseTo(400 / 764);
    expect(fit.w).toBeCloseTo(400);
    expect(fit.x).toBe(0);
    expect(fit.y).toBeCloseTo((800 - 1200 * (400 / 764)) / 2);
  });
  it("fits a spread to the width", () => {
    const fit = fitPage(1600, 1200, 400, 800);
    expect(fit.w).toBe(400);
    expect(fit.h).toBe(300);
    expect(fit.y).toBe(250);
  });
});

describe("zoom + pan bounds", () => {
  const fit = fitPage(764, 1200, 400, 800);
  it("clamps scale and centres a page smaller than the stage", () => {
    const v = clampView({ s: 0.5, tx: 30, ty: -20 }, fit, 400, 800);
    expect(v.s).toBe(1);
    expect(v.tx).toBe(0);
    expect(v.ty).toBe(0);
  });
  it("keeps a zoomed page covering the stage", () => {
    const v = clampView({ s: 2, tx: 50, ty: 50 }, fit, 400, 800);
    expect(v.tx).toBe(-fit.x); // left edge can't leave the stage's left
    expect(fit.y + v.ty).toBeLessThanOrEqual(0);
    const far = clampView({ s: 2, tx: -9999, ty: -9999 }, fit, 400, 800);
    expect(fit.x + far.tx + fit.w * 2).toBeCloseTo(400); // right edge pinned
    expect(fit.y + far.ty + fit.h * 2).toBeCloseTo(800);
  });
  it("zooms about the finger", () => {
    const v0 = { s: 1, tx: 0, ty: 0 };
    const px = 100;
    const py = 300;
    const v = zoomAbout(v0, fit, 2, px, py);
    // the page point under (px, py) is still under it after the zoom
    const pageX = (px - fit.x - v0.tx) / v0.s;
    expect(fit.x + v.tx + pageX * v.s).toBeCloseTo(px);
    const pageY = (py - fit.y - v0.ty) / v0.s;
    expect(fit.y + v.ty + pageY * v.s).toBeCloseTo(py);
  });
});

describe("tap zones / swipes / turns", () => {
  it("far side in the reading direction turns forward", () => {
    expect(tapZone(10, 300, "rtl")).toBe("next");
    expect(tapZone(290, 300, "rtl")).toBe("prev");
    expect(tapZone(10, 300, "ltr")).toBe("prev");
    expect(tapZone(150, 300, "rtl")).toBe("center");
  });
  it("swipe direction follows the page order", () => {
    expect(swipeTurn(-80, "rtl")).toBe(-1); // content dragged left → page on the right → previous
    expect(swipeTurn(80, "rtl")).toBe(1);
    expect(swipeTurn(-80, "ltr")).toBe(1);
  });
  it("turnPage clamps", () => {
    expect(turnPage(0, 3, -1)).toBeNull();
    expect(turnPage(2, 3, 1)).toBeNull();
    expect(turnPage(1, 3, 1)).toBe(2);
  });
});

const sentences: TranscriptSentence[] = [
  { idx: 0, start: 0, end: 0, tokens: [
    { s: "犬", l: "犬", c: 1, k: 1 }, { s: "が", l: "が" }, { s: "走る", l: "走る", c: 1 }, { s: "。" }] },
  { idx: 1, start: 0, end: 0, tokens: [{ s: "速い", l: "速い", c: 1 }, { s: "ね", l: "ね" }, { s: "。" }] },
];

describe("blockLines", () => {
  it("cuts tokens into the printed lines, splitting a wrapped token", () => {
    // printed as 犬が走 / る。速 / いね。  (a token 走る wraps, 速い wraps)
    const block: MangaBlock = { box: [0, 0, 60, 200], vertical: true, font_size: 20,
      lines: [3, 3, 3], sents: [0, 1] };
    const lines = blockLines(block, sentences);
    expect(lines.map((l) => l.map((f) => f.text).join(""))).toEqual(["犬が走", "る。速", "いね。"]);
    // the wrapped token keeps its identity on both lines
    const walk = lines[0][2];
    const rest = lines[1][0];
    expect([walk.si, walk.ti, walk.token.l]).toEqual([0, 2, "走る"]);
    expect([rest.si, rest.ti]).toEqual([0, 2]);
  });
  it("falls back to one line when the counts disagree", () => {
    const block: MangaBlock = { box: [0, 0, 60, 200], vertical: true, font_size: 20,
      lines: [4, 4], sents: [0, 1] };
    const lines = blockLines(block, sentences);
    expect(lines).toHaveLength(1);
    expect(lines[0].map((f) => f.text).join("")).toBe("犬が走る。速いね。");
  });
});

describe("blockStyle", () => {
  it("shares the box across lines and caps the glyph size to the box", () => {
    const block: MangaBlock = { box: [100, 50, 160, 350], vertical: true, font_size: 40,
      lines: [10, 5], sents: [] };
    const st = blockStyle(block, 0.5);
    expect([st.left, st.top, st.width, st.height]).toEqual([50, 25, 30, 150]);
    expect(st.lineSize).toBe(15); // two vertical lines share the 30px width
    // 40 * 0.5 = 20px would overflow: 10 chars must fit 150px → ~15.75
    expect(st.fontSize).toBeCloseTo(15.75);
    expect(st.vertical).toBe(true);
  });
});
