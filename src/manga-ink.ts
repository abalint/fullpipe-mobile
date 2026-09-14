// Ink measurement for the manga reader: where the printed glyphs of a line
// actually are. The OCR's line box (mokuro's polygon) is loose — a tenth
// longer than the lettering on most lines, and manga letters sit tighter
// than one em — so laying a line's characters evenly along the box drifts
// by a glyph over a long column. The page scan is on the phone, so the
// reader measures instead: project the line's pixels onto its writing axis,
// cut the profile into ink runs, and cut the ink extent into one cell per
// character the AI read on the line (the runs themselves when they number
// the characters, else a width-weighted grid snapped to the ink gaps).
// Each token then sits on its own glyph cells.
//
// Pure functions over ImageData-shaped input so they test without a canvas.

export interface Run {
  a: number; // page px along the writing axis, inclusive start
  b: number; // exclusive end
}

export interface LineGlyphs {
  runs: Run[]; // one per character, in reading order along the axis
  cross: [number, number]; // ink extent across the axis, page px
}

export interface Pixels {
  data: Uint8ClampedArray | Uint8Array | number[];
  width: number;
  height: number;
}

const INK_MARGIN = 55; // luminance distance from the background that counts as ink
const BORDER_FILL = 0.8; // an edge row/column this full of ink is a bubble border, not text
const BORDER_ZONE = 0.2; // …looked for only in the outer fifth of each axis

/** Luminance 0–255 of pixel i (RGBA). */
const lum = (d: Pixels["data"], i: number) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;

/** Contiguous runs of indices where prof[i] > 0. */
export function inkRuns(prof: ArrayLike<number>): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let i = 0; i <= prof.length; i++) {
    const on = i < prof.length && prof[i] > 0;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      runs.push({ a: start, b: i });
      start = -1;
    }
  }
  return runs;
}

/** Nominal cell widths of a line's characters, in glyph pitches: manga
    lettering squeezes brackets and punctuation into half a cell, and a
    doubled ！！ / ！？ is set as one ligature cell (‼ ⁉). */
const HALF = /[「」『』（）()〈〉《》【】〔〕、。，．・:：;；]/;
export function cellWeights(text: string): number[] {
  const w = [...text].map((ch) => (HALF.test(ch) ? 0.5 : 1));
  const chars = [...text];
  for (let i = 0; i + 1 < chars.length; i++)
    if (/[！？!?]/.test(chars[i]) && /[！？!?]/.test(chars[i + 1]) && w[i] === 1 && w[i + 1] === 1)
      w[i] = w[i + 1] = 0.5;
  return w;
}

/** Cut the ink extent [lo, hi) into one cell per character. When the ink
    runs already number the characters, the cells meet at the midpoints of
    the gaps between them (a cell is a glyph plus its share of the leading).
    Otherwise (a … in three dots, a ！ with its dot, touching glyphs, a
    half-width 「 hugging the next kanji) a grid of the characters' nominal
    widths spans the extent, and each interior boundary snaps to an ink gap
    lying within a quarter cell of it — the grid keeps the drift bounded,
    the gaps fix it locally. */
export function cellsFor(runs: Run[], lo: number, hi: number, weights: number[]): Run[] {
  const n = weights.length;
  if (!n || hi <= lo) return [];
  const bounds: number[] = [lo];
  if (runs.length === n) {
    for (let k = 1; k < n; k++) bounds.push((runs[k - 1].b + runs[k].a) / 2);
  } else {
    const total = weights.reduce((a, b) => a + b, 0);
    const p = (hi - lo) / total;
    const gaps = runs.slice(1).map((r, i) => (runs[i].b + r.a) / 2);
    let acc = lo;
    for (let k = 1; k < n; k++) {
      acc += weights[k - 1] * p;
      const tol = (p * Math.min(weights[k - 1], weights[k])) / 4;
      let best = acc;
      let dist = tol;
      for (const g of gaps) {
        const dd = Math.abs(g - acc);
        if (dd < dist && g > bounds[bounds.length - 1]) {
          dist = dd;
          best = g;
        }
      }
      bounds.push(Math.max(bounds[bounds.length - 1], best));
    }
  }
  bounds.push(hi);
  return bounds.slice(1).map((b, k) => ({ a: bounds[k], b }));
}

/** The glyph cells of one printed line: `box` is the OCR's line box in
    page px, `text` the characters the read put on the line, `scale` the
    scan's px per page px (the scan may not be the OCR's size). Null when
    the box holds no ink (or lies outside the scan) — the caller falls back
    to the box. Text on a dark ground (narration boxes) is handled: ink is
    whatever differs from the box's dominant tone. */
export function lineGlyphs(
  img: Pixels,
  box: [number, number, number, number],
  text: string,
  vertical: boolean,
  scale = 1,
): LineGlyphs | null {
  const weights = cellWeights(text);
  const n = weights.length;
  const x1 = Math.max(0, Math.floor(box[0] * scale));
  const y1 = Math.max(0, Math.floor(box[1] * scale));
  const x2 = Math.min(img.width, Math.ceil(box[2] * scale));
  const y2 = Math.min(img.height, Math.ceil(box[3] * scale));
  const W = x2 - x1;
  const H = y2 - y1;
  if (W <= 0 || H <= 0 || n <= 0) return null;
  const d = img.data;
  // the box's dominant tone is the ground; ink is what stands off it
  const hist = new Int32Array(256);
  const L = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const l = lum(d, ((y1 + y) * img.width + (x1 + x)) * 4) | 0;
      L[y * W + x] = l;
      hist[l]++;
    }
  let ground = 0;
  for (let l = 1; l < 256; l++) if (hist[l] > hist[ground]) ground = l;
  const isInk = (l: number) => Math.abs(l - ground) > INK_MARGIN;
  const along = vertical ? H : W;
  const cross = vertical ? W : H;
  const at = (i: number, c: number) => (vertical ? L[i * W + c] : L[c * W + i]); // i along, c across
  // ink counts per along-index and per cross-index
  const prof = new Int32Array(along);
  const cprof = new Int32Array(cross);
  for (let i = 0; i < along; i++)
    for (let c = 0; c < cross; c++)
      if (isInk(at(i, c))) {
        prof[i]++;
        cprof[c]++;
      }
  // a bubble border clipped by a loose box: full rows / columns hugging an edge
  let c0 = 0;
  let c1 = cross;
  const czone = Math.ceil(cross * BORDER_ZONE);
  while (c0 < czone && cprof[c0] >= along * BORDER_FILL) c0++;
  while (c1 > cross - czone && cprof[c1 - 1] >= along * BORDER_FILL) c1--;
  let i0 = 0;
  let i1 = along;
  const izone = Math.ceil(along * BORDER_ZONE);
  while (i0 < izone && prof[i0] >= cross * BORDER_FILL) i0++;
  while (i1 > along - izone && prof[i1 - 1] >= cross * BORDER_FILL) i1--;
  if (c0 >= c1 || i0 >= i1) return null;
  // recount along the kept cross range
  const kept = new Int32Array(along);
  let lo = -1;
  let hi = -1;
  for (let i = i0; i < i1; i++) {
    for (let c = c0; c < c1; c++) if (isInk(at(i, c))) kept[i]++;
    if (kept[i]) {
      if (lo < 0) lo = i;
      hi = i;
    }
  }
  if (lo < 0) return null;
  let cl = -1;
  let ch = -1;
  for (let c = c0; c < c1; c++) {
    let any = false;
    for (let i = lo; i <= hi && !any; i++) any = isInk(at(i, c));
    if (any) {
      if (cl < 0) cl = c;
      ch = c;
    }
  }
  const runs = cellsFor(inkRuns(kept), lo, hi + 1, weights);
  if (runs.length !== n) return null;
  const origin = vertical ? y1 : x1;
  const corigin = vertical ? x1 : y1;
  return {
    runs: runs.map((r) => ({ a: (origin + r.a) / scale, b: (origin + r.b) / scale })),
    cross: [(corigin + cl) / scale, (corigin + ch + 1) / scale],
  };
}

/** The box, in page px, that the characters [c0, c1) of a measured line
    occupy: their first glyph's start to their last glyph's end along the
    axis, the line's ink extent across it. */
export function glyphSpanBox(
  g: LineGlyphs,
  c0: number,
  c1: number,
  vertical: boolean,
): [number, number, number, number] {
  const a = g.runs[c0].a;
  const b = g.runs[c1 - 1].b;
  return vertical ? [g.cross[0], a, g.cross[1], b] : [a, g.cross[0], b, g.cross[1]];
}
