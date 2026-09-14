import { describe, expect, it } from "vitest";
import {
  blockLines,
  blockBox,
  blockStyle,
  clampView,
  lineStyle,
  dragTurn,
  fitPage,
  slotAnchor,
  slotAt,
  slotsIn,
  stripFit,
  stripLayout,
  swipeTurn,
  swipeTurnFor,
  tapZone,
  tapZoneFor,
  turnPage,
  viewRange,
  viewToSlot,
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
  it("vertical mode: zones run top to bottom, swipes up turn forward", () => {
    expect(tapZoneFor(150, 10, 300, 600, "vertical")).toBe("prev");
    expect(tapZoneFor(150, 590, 300, 600, "vertical")).toBe("next");
    expect(tapZoneFor(150, 300, 300, 600, "vertical")).toBe("center");
    expect(tapZoneFor(10, 300, 300, 600, "rtl")).toBe("next"); // page-order modes unchanged
    expect(dragTurn(-50, "vertical")).toBe(1);
    expect(dragTurn(50, "vertical")).toBe(-1);
    expect(swipeTurnFor(5, -80, "vertical", 60)).toBe(1);
    expect(swipeTurnFor(-80, 5, "vertical", 60)).toBeNull(); // across the axis
    expect(swipeTurnFor(0, -30, "vertical", 60)).toBeNull(); // too short
    expect(swipeTurnFor(80, 10, "rtl", 60)).toBe(1);
    expect(swipeTurnFor(80, 90, "rtl", 60)).toBeNull();
  });
  it("turnPage clamps", () => {
    expect(turnPage(0, 3, -1)).toBeNull();
    expect(turnPage(2, 3, 1)).toBeNull();
    expect(turnPage(1, 3, 1)).toBe(2);
  });
});

describe("continuous strip", () => {
  // a portrait page, a spread, a portrait page, and one the OCR never sized
  const sizes = [{ w: 800, h: 1200 }, { w: 1600, h: 1200 }, { w: 800, h: 1200 }, { w: 0, h: 0 }];
  it("vertical: pages fit the width and stack; unknown sizes take the median aspect", () => {
    const strip = stripLayout(sizes, 400, 800, "vertical");
    expect(strip.vertical).toBe(true);
    expect(strip.slots.map((s) => [s.y, s.h])).toEqual([[0, 600], [600, 300], [900, 600], [1500, 600]]);
    expect(strip.slots[0].f).toBe(0.5);
    expect(strip.w).toBe(400);
    expect(strip.h).toBe(2100);
    const fit = stripFit(strip, 400, 800);
    expect([fit.x, fit.y, fit.w, fit.h]).toEqual([0, 0, 400, 2100]);
  });
  it("horizontal: pages fit the height side by side, page 0 at the right end for RTL", () => {
    const ltr = stripLayout(sizes, 400, 800, "ltr");
    const xs = ltr.slots.map((s) => s.x);
    expect(xs[0]).toBe(0);
    expect(xs[1]).toBeCloseTo(533.33);
    expect(xs[2]).toBeCloseTo(1600);
    expect(ltr.slots[1].w).toBeCloseTo(1066.67);
    expect(ltr.w).toBeCloseTo(2666.67);
    const rtl = stripLayout(sizes, 400, 800, "rtl");
    expect(rtl.w).toBeCloseTo(2666.67);
    expect(rtl.slots[0].x).toBeCloseTo(2133.33); // page 0 at the right end
    expect(rtl.slots[3].x).toBeCloseTo(0);
  });
  it("finds the pages in view and the page under the centre", () => {
    const strip = stripLayout(sizes, 400, 800, "vertical");
    expect(slotsIn(strip, 500, 700).map((s) => s.i)).toEqual([0, 1]);
    expect(slotAt(strip, 650)).toBe(1);
    expect(slotAt(strip, -5)).toBe(0);
    expect(slotAt(strip, 99999)).toBe(3);
    const rtl = stripLayout(sizes, 400, 800, "rtl");
    expect(slotAt(rtl, -5)).toBe(3); // the left end is the last page
    expect(slotAt(rtl, 99999)).toBe(0);
  });
  it("scrolls to a page's reading-start edge and reads the window back", () => {
    const strip = stripLayout(sizes, 400, 800, "vertical");
    const fit = stripFit(strip, 400, 800);
    const v = clampView(viewToSlot(strip, 1, fit, { s: 1, tx: 0, ty: 0 }, 1, 400, "vertical"), fit, 400, 800);
    expect(v.ty).toBe(-600);
    expect(viewRange(v, fit, 400, 800, true)).toEqual([600, 1400]);
    // zoomed 2×: the window halves in strip px
    const z = clampView(viewToSlot(strip, 1, fit, { s: 2, tx: 0, ty: 0 }, 2, 400, "vertical"), fit, 400, 800);
    expect(viewRange(z, fit, 400, 800, true)).toEqual([600, 1000]);
    const rtl = stripLayout(sizes, 400, 800, "rtl");
    const rfit = stripFit(rtl, 400, 800);
    const r0 = clampView(viewToSlot(rtl, 0, rfit, { s: 1, tx: 0, ty: 0 }, 1, 400, "rtl"), rfit, 400, 800);
    expect(r0.tx + rtl.w).toBeCloseTo(400); // page 0's right edge on the stage's right edge
    expect(slotAt(rtl, viewRange(r0, rfit, 400, 800, false)[0] + 200)).toBe(0);
  });
  it("an anchor into a page survives a relayout at another size", () => {
    for (const mode of ["vertical", "ltr", "rtl"] as const) {
      const a = stripLayout(sizes, 400, 800, mode);
      const af = stripFit(a, 400, 800);
      const v = clampView(viewToSlot(a, 1, af, { s: 1, tx: 0, ty: 0 }, 1, 400, mode, 0.25), af, 400, 800);
      const frac = slotAnchor(a, 1, v, af, 400, 800, mode);
      expect(frac).toBeCloseTo(0.25);
      // rotate the phone: same fraction of the same page under the edge
      const b = stripLayout(sizes, 800, 400, mode);
      const bf = stripFit(b, 800, 400);
      const w = clampView(viewToSlot(b, 1, bf, v, 1, 800, mode, frac), bf, 800, 400);
      expect(slotAnchor(b, 1, w, bf, 800, 400, mode)).toBeCloseTo(0.25);
    }
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

describe("lineStyle / blockBox", () => {
  it("lays a line on its own OCR box: glyphs at the printed pitch", () => {
    // a vertical column 30 wide × 200 tall holding 5 glyphs at fit 0.5
    const st = lineStyle([100, 50, 130, 250], 5, true, 0.5, [90, 40]);
    expect([st.left, st.top, st.width, st.height]).toEqual([5, 5, 15, 100]);
    // pitch 20px, glyph capped at the column's 15px, the rest is spacing
    expect(st.fontSize).toBe(15);
    expect(st.letterSpacing).toBe(5);
    // a horizontal line 200 wide × 30 tall, 10 glyphs: pitch 10 < 15 → 10, no spacing
    const h = lineStyle([0, 0, 400, 60], 10, false, 0.5, [0, 0]);
    expect(h.fontSize).toBe(20);
    expect(h.letterSpacing).toBe(0);
  });

  it("the block box is the union of its line boxes when it has them", () => {
    const block: MangaBlock = { box: [100, 50, 160, 350], vertical: true, font_size: 40,
      lines: [10, 5], sents: [], line_boxes: [[130, 40, 165, 360], [95, 50, 125, 200]] };
    expect(blockBox(block)).toEqual([95, 40, 165, 360]);
    expect(blockStyle(block, 1).left).toBe(95);
    expect(blockBox({ ...block, line_boxes: undefined })).toEqual([100, 50, 160, 350]);
  });
});
