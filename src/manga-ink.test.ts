import { describe, expect, it } from "vitest";
import { cellsFor, cellWeights, glyphSpanBox, inkRuns, lineGlyphs } from "./manga-ink";
import type { Pixels } from "./manga-ink";

/** A W×H RGBA image of one tone, with `marks` rectangles in another. */
function image(W: number, H: number, ground: number, ink: number, marks: [number, number, number, number][]): Pixels {
  const data = new Uint8ClampedArray(W * H * 4);
  const put = (x: number, y: number, v: number) => {
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, ground);
  for (const [x1, y1, x2, y2] of marks)
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) put(x, y, ink);
  return { data, width: W, height: H };
}

describe("inkRuns / cellsFor", () => {
  it("cuts a profile into runs", () => {
    expect(inkRuns([0, 0, 3, 5, 0, 1, 0, 0, 2])).toEqual([{ a: 2, b: 4 }, { a: 5, b: 6 }, { a: 8, b: 9 }]);
  });

  it("weights brackets, punctuation and a doubled ！！ as half cells", () => {
    expect(cellWeights("「航空」を！")).toEqual([0.5, 1, 1, 0.5, 1, 1]);
    expect(cellWeights("ですよ！！")).toEqual([1, 1, 1, 0.5, 0.5]);
  });

  it("runs that number the characters become cells meeting mid-gap", () => {
    const runs = [{ a: 10, b: 30 }, { a: 40, b: 60 }, { a: 70, b: 90 }];
    expect(cellsFor(runs, 10, 90, [1, 1, 1])).toEqual([{ a: 10, b: 35 }, { a: 35, b: 65 }, { a: 65, b: 90 }]);
  });

  it("otherwise a weighted grid spans the ink, snapped to nearby gaps", () => {
    // 「 (half) + two kanji + 」(half): 「 hugs the first kanji, so 3 runs for 4 chars
    const runs = [{ a: 0, b: 38 }, { a: 42, b: 68 }, { a: 72, b: 84 }];
    const cells = cellsFor(runs, 0, 84, [0.5, 1, 1, 0.5]);
    // grid pitch 28: 「 ends at 14 (no gap near), 航|空 at 42 → snaps to the gap at 40,
    // 空|」 at 70 → snaps to the gap at 70
    expect(cells).toEqual([{ a: 0, b: 14 }, { a: 14, b: 40 }, { a: 40, b: 70 }, { a: 70, b: 84 }]);
    // a … in three dots + one glyph, read as two characters: the grid's
    // midpoint (37.5) snaps to the real gap between the dots and the glyph
    expect(cellsFor([{ a: 5, b: 9 }, { a: 15, b: 19 }, { a: 25, b: 29 }, { a: 50, b: 70 }], 5, 70, [1, 1]))
      .toEqual([{ a: 5, b: 39.5 }, { a: 39.5, b: 70 }]);
  });
});

describe("lineGlyphs", () => {
  // a vertical column: five 20×20 glyphs at a 35px pitch, x 10..30
  const glyphs: [number, number, number, number][] = [10, 45, 80, 115, 150].map((y) => [10, y, 30, y + 20]);

  // cells: ink extent 10..170, boundaries midway between glyphs
  const cells = [{ a: 10, b: 37.5 }, { a: 37.5, b: 72.5 }, { a: 72.5, b: 107.5 }, { a: 107.5, b: 142.5 }, { a: 142.5, b: 170 }];

  it("finds each glyph's cell along the column and the ink across it", () => {
    const g = lineGlyphs(image(40, 200, 255, 0, glyphs), [2, 0, 38, 200], "五つの文字", true)!;
    expect(g.runs).toEqual(cells);
    expect(g.cross).toEqual([10, 30]);
    // the characters [1, 3) of the line → a box on the 2nd + 3rd cells
    expect(glyphSpanBox(g, 1, 3, true)).toEqual([10, 37.5, 30, 107.5]);
  });

  it("reads white lettering on a dark ground, and scales a larger scan", () => {
    const g = lineGlyphs(image(80, 400, 20, 240, glyphs.map((b) => b.map((v) => v * 2) as [number, number, number, number])),
      [2, 0, 38, 200], "五つの文字", true, 2)!;
    expect(g.runs).toEqual(cells);
    expect(g.cross).toEqual([10, 30]);
  });

  it("ignores a bubble border caught by a loose box, and gives up on an empty one", () => {
    const withBorder = image(40, 200, 255, 0, [...glyphs, [0, 0, 2, 200], [0, 196, 40, 200]]);
    const g = lineGlyphs(withBorder, [0, 0, 40, 200], "五つの文字", true)!;
    expect(g.runs).toEqual(cells);
    expect(g.cross).toEqual([10, 30]);
    expect(lineGlyphs(image(40, 200, 255, 0, []), [0, 0, 40, 200], "三文字", true)).toBeNull();
  });

  it("a … in three dots and a touching pair still come out one cell per character", () => {
    const dots = image(40, 100, 255, 0, [[18, 5, 22, 9], [18, 15, 22, 19], [18, 25, 22, 29], [10, 50, 30, 70]]);
    expect(lineGlyphs(dots, [0, 0, 40, 100], "…字", true)!.runs).toEqual([{ a: 5, b: 39.5 }, { a: 39.5, b: 70 }]);
    const touching = image(40, 100, 255, 0, [[10, 10, 30, 50]]);
    expect(lineGlyphs(touching, [0, 0, 40, 100], "二字", true)!.runs).toEqual([{ a: 10, b: 30 }, { a: 30, b: 50 }]);
  });
});
