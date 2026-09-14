// Pure geometry + text layout for the manga reader (manga-reader.ts) — the
// parts worth testing without a DOM: fitting a page into the stage, the
// zoom/pan bounds, tap zones for the reading direction, and cutting a
// bubble's transcript tokens back into the printed lines so the invisible
// overlay tracks the art. The reading behaviours come from the comicReader
// app (Kotlin): fit-to-screen pages, spreads fit to width, pinch 1–5×,
// double-tap 1↔2× about the tap point, zoom kept across page turns, and a
// pull past the edge of a zoomed page turning it.

import type { MangaBlock, Token, TranscriptSentence } from "./types";

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
export const DOUBLE_TAP_SCALE = 2;
/** A page wider than this (w/h) is a two-page spread: fit to width, like
    comicReader's spread detection. */
export const SPREAD_RATIO = 1.2;

export type Direction = "rtl" | "ltr";

export interface Fit {
  w: number; // rendered page size at scale 1
  h: number;
  x: number; // top-left within the stage at scale 1 (centred)
  y: number;
  f: number; // page px → css px
}

/** Fit a page (pw×ph) into the stage (sw×sh): whole page visible, centred;
    a spread fills the width instead (its height may exceed the stage — the
    pan bounds handle that). */
export function fitPage(pw: number, ph: number, sw: number, sh: number): Fit {
  if (pw <= 0 || ph <= 0 || sw <= 0 || sh <= 0) return { w: 0, h: 0, x: 0, y: 0, f: 1 };
  const spread = pw / ph > SPREAD_RATIO;
  const f = spread ? sw / pw : Math.min(sw / pw, sh / ph);
  const w = pw * f;
  const h = ph * f;
  return { w, h, x: (sw - w) / 2, y: Math.max(0, (sh - h) / 2), f };
}

export interface View {
  s: number; // scale
  tx: number; // translation of the page's top-left corner, css px, relative to fit.x/fit.y
  ty: number;
}

/** Keep the zoomed page covering the stage (no black gaps once it's larger
    than the viewport) and centred while it's smaller. */
export function clampView(v: View, fit: Fit, sw: number, sh: number): View {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.s));
  const cw = fit.w * s;
  const ch = fit.h * s;
  const axis = (t: number, origin: number, content: number, stage: number) => {
    if (content <= stage + 0.5) return (stage - content) / 2 - origin; // centre
    return Math.min(-origin, Math.max(stage - content - origin, t)); // cover
  };
  return { s, tx: axis(v.tx, fit.x, cw, sw), ty: axis(v.ty, fit.y, ch, sh) };
}

/** Zoom to `s` keeping the page point under stage point (px, py) still. */
export function zoomAbout(v: View, fit: Fit, s: number, px: number, py: number): View {
  const k = s / v.s;
  // page-space point under the finger: (p - origin - t) / s
  const ox = fit.x + v.tx;
  const oy = fit.y + v.ty;
  return { s, tx: px - fit.x - (px - ox) * k, ty: py - fit.y - (py - oy) * k };
}

export type Zone = "next" | "prev" | "center";

/** Which third of the stage a tap landed in, in reading terms: the far
    side in the reading direction turns forward. RTL: left = next. */
export function tapZone(x: number, sw: number, dir: Direction): Zone {
  const third = x / sw;
  if (third < 1 / 3) return dir === "rtl" ? "next" : "prev";
  if (third > 2 / 3) return dir === "rtl" ? "prev" : "next";
  return "center";
}

/** A horizontal drag/swipe of dx px (finger movement): which way it turns.
    Dragging the content leftwards (dx < 0) reveals what lies to the right —
    the previous page in RTL, the next in LTR. */
export function swipeTurn(dx: number, dir: Direction): 1 | -1 {
  const towardRight = dx < 0;
  return (dir === "rtl" ? !towardRight : towardRight) ? 1 : -1;
}

/** Fragment of a token that lands on one printed line (a token can wrap). */
export interface Frag {
  text: string;
  si: number; // sentence idx in the transcript
  ti: number; // token index within that sentence
  token: Token;
}

/** Lay a bubble's sentences back into its printed lines by character count.
    The transcript tokens concatenate to the bubble text exactly (the PC
    dropped whitespace before counting), so walking characters against the
    OCR line lengths reproduces the wrap; a token that straddles a line
    break splits into two fragments with the same identity. If the counts
    disagree (an old sidecar), everything lands on one line. */
export function blockLines(block: MangaBlock, sentences: TranscriptSentence[]): Frag[][] {
  const seq: Frag[] = [];
  for (const si of block.sents) {
    const s = sentences[si];
    if (!s) continue;
    s.tokens.forEach((t, ti) => seq.push({ text: t.s, si, ti, token: t }));
  }
  const total = seq.reduce((n, f) => n + f.text.length, 0);
  const counted = block.lines.reduce((a, b) => a + b, 0);
  if (!block.lines.length || total !== counted) return seq.length ? [seq] : [];
  const lines: Frag[][] = [];
  let i = 0; // fragment index
  let off = 0; // chars of seq[i] already placed
  for (const want of block.lines) {
    const line: Frag[] = [];
    let left = want;
    while (left > 0 && i < seq.length) {
      const f = seq[i];
      const avail = f.text.length - off;
      const take = Math.min(avail, left);
      line.push({ ...f, text: f.text.slice(off, off + take) });
      left -= take;
      off += take;
      if (off >= f.text.length) {
        i++;
        off = 0;
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface BlockStyle {
  left: number; // css px within the page at scale 1
  top: number;
  width: number;
  height: number;
  fontSize: number; // px
  lineSize: number; // px per printed line (line-height)
  vertical: boolean;
}

/** Where and how big a bubble renders at fit scale f: the OCR box, the
    lines sharing the box across its writing axis, the glyph size from the
    OCR estimate capped so the longest line fits its box. */
export function blockStyle(block: MangaBlock, f: number): BlockStyle {
  const [x1, y1, x2, y2] = block.box;
  const width = Math.max(1, (x2 - x1) * f);
  const height = Math.max(1, (y2 - y1) * f);
  const n = Math.max(1, block.lines.length);
  const lineSize = (block.vertical ? width : height) / n;
  const longest = Math.max(1, ...block.lines);
  const along = block.vertical ? height : width;
  const est = block.font_size > 0 ? block.font_size * f : along / longest;
  const fontSize = Math.max(6, Math.min(est, (along / longest) * 1.05, lineSize * 1.15));
  return { left: x1 * f, top: y1 * f, width, height, fontSize, lineSize,
           vertical: block.vertical };
}

/** Page index after a turn of `delta`, clamped; null when already at the end. */
export function turnPage(i: number, count: number, delta: 1 | -1): number | null {
  const j = i + delta;
  return j < 0 || j >= count ? null : j;
}
