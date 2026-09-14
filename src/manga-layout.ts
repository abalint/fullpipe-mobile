// Pure geometry + text layout for the manga reader (manga-reader.ts) — the
// parts worth testing without a DOM: fitting a page into the stage, the
// zoom/pan bounds, tap zones for the reading direction, and cutting a
// bubble's transcript tokens back into the printed lines so the invisible
// overlay tracks the art. The reading behaviours come from the comicReader
// app (Kotlin): fit-to-screen pages, spreads fit to width, pinch 1–5×,
// double-tap 1↔2× about the tap point, zoom kept across page turns, and a
// pull past the edge of a zoomed page turning it — plus its reading modes:
// page order left-to-right / right-to-left or a vertical scroll, each
// either paged or as one continuous strip of pages (stripLayout).

import type { MangaBlock, Token, TranscriptSentence } from "./types";

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
export const DOUBLE_TAP_SCALE = 2;
/** A page wider than this (w/h) is a two-page spread: fit to width, like
    comicReader's spread detection. */
export const SPREAD_RATIO = 1.2;

export type Direction = "rtl" | "ltr";
/** comicReader's ReadingMode: page order, or pages read top-to-bottom. */
export type Mode = Direction | "vertical";

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

/** The zone for a reading mode: thirds across the stage for the page-order
    modes, thirds down it for vertical (the bottom third turns forward). */
export function tapZoneFor(x: number, y: number, sw: number, sh: number, mode: Mode): Zone {
  if (mode !== "vertical") return tapZone(x, sw, mode);
  const third = y / sh;
  if (third < 1 / 3) return "prev";
  if (third > 2 / 3) return "next";
  return "center";
}

/** A horizontal drag/swipe of dx px (finger movement): which way it turns.
    Dragging the content leftwards (dx < 0) reveals what lies to the right —
    the previous page in RTL, the next in LTR. */
export function swipeTurn(dx: number, dir: Direction): 1 | -1 {
  const towardRight = dx < 0;
  return (dir === "rtl" ? !towardRight : towardRight) ? 1 : -1;
}

/** A drag of `d` px along the mode's axis (finger movement — or how far a
    zoomed page was pulled past its bound): which way it turns. Vertical:
    content dragged upwards (d < 0) reveals the page below. */
export function dragTurn(d: number, mode: Mode): 1 | -1 {
  if (mode === "vertical") return d < 0 ? 1 : -1;
  return swipeTurn(d, mode);
}

/** A finished drag of (dx, dy): the turn it asks for, or null when it was
    too short or ran mostly across the mode's axis. */
export function swipeTurnFor(dx: number, dy: number, mode: Mode, min: number): 1 | -1 | null {
  const vertical = mode === "vertical";
  const along = vertical ? dy : dx;
  const across = vertical ? dx : dy;
  if (Math.abs(along) < min || Math.abs(along) < Math.abs(across)) return null;
  return dragTurn(along, mode);
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
  const [x1, y1, x2, y2] = blockBox(block);
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

export interface LineStyle {
  left: number; // css px within the block at scale 1
  top: number;
  width: number;
  height: number;
  fontSize: number; // px
  letterSpacing: number; // px added after each glyph so n glyphs span the line
}

/** Where one printed line sits within its block at fit scale f, from the
    OCR's own box for that line: the glyphs are laid at the line's pitch
    (its length over its character count), sized to that pitch but no
    wider than the line (the OCR box is the glyph size across), and the
    slack between glyph and pitch becomes letter-spacing — so each glyph
    lands on the printed one, not just the line as a whole. */
export function lineStyle(
  box: [number, number, number, number],
  chars: number,
  vertical: boolean,
  f: number,
  origin: [number, number],
): LineStyle {
  const [x1, y1, x2, y2] = box;
  const width = Math.max(1, (x2 - x1) * f);
  const height = Math.max(1, (y2 - y1) * f);
  const along = vertical ? height : width;
  const cross = vertical ? width : height;
  const n = Math.max(1, chars);
  const pitch = along / n;
  const fontSize = Math.max(4, Math.min(cross, pitch));
  return {
    left: (x1 - origin[0]) * f,
    top: (y1 - origin[1]) * f,
    width,
    height,
    fontSize,
    letterSpacing: Math.max(0, pitch - fontSize),
  };
}

/** The block's box for the overlay: the union of its line boxes when it
    has them (mokuro's block box can sit inside or beside its lines), else
    the block box itself. */
export function blockBox(block: MangaBlock): [number, number, number, number] {
  const boxes = block.line_boxes;
  if (!boxes?.length) return block.box;
  let [x1, y1, x2, y2] = boxes[0];
  for (const [a, b, c, d] of boxes) {
    x1 = Math.min(x1, a);
    y1 = Math.min(y1, b);
    x2 = Math.max(x2, c);
    y2 = Math.max(y2, d);
  }
  return [x1, y1, x2, y2];
}

// --- continuous scrolling -----------------------------------------------------------
// comicReader's "Scroll" checkbox: every page in one strip — fit to the
// stage width and stacked for vertical, fit to the stage height and laid
// side by side for the page-order modes (page 0 at the right end for RTL).
// The strip is one big "page" for the zoom/pan maths above: stripFit gives
// its Fit, clampView / zoomAbout work unchanged, and the reader mounts only
// the slots near the viewport.

export interface Slot {
  i: number; // page index
  x: number; // within the strip at scale 1
  y: number;
  w: number;
  h: number;
  f: number; // page px → css px for this page's bubbles
}

export interface Strip {
  slots: Slot[]; // in page order (positions run backwards for RTL)
  w: number; // total extent at scale 1
  h: number;
  vertical: boolean;
}

/** Lay every page into the strip. A page whose size the OCR didn't record
    takes the median aspect of the ones that did (2:3 when none did) until
    its scan loads. */
export function stripLayout(sizes: { w: number; h: number }[], sw: number, sh: number, mode: Mode): Strip {
  const ratios = sizes.filter((s) => s.w > 0 && s.h > 0).map((s) => s.w / s.h).sort((a, b) => a - b);
  const fallback = ratios.length ? ratios[ratios.length >> 1] : 2 / 3;
  const vertical = mode === "vertical";
  const slots: Slot[] = [];
  let along = 0;
  sizes.forEach((s, i) => {
    const known = s.w > 0 && s.h > 0;
    const r = known ? s.w / s.h : fallback;
    if (vertical) {
      const h = sw / r;
      slots.push({ i, x: 0, y: along, w: sw, h, f: known ? sw / s.w : 1 });
      along += h;
    } else {
      const w = sh * r;
      slots.push({ i, x: along, y: 0, w, h: sh, f: known ? sh / s.h : 1 });
      along += w;
    }
  });
  if (mode === "rtl") for (const s of slots) s.x = along - s.x - s.w;
  return { slots, w: vertical ? sw : along, h: vertical ? along : sh, vertical };
}

/** The strip as one page for the view maths: centred across the axis when
    narrower than the stage, starting at the stage's origin otherwise. */
export function stripFit(strip: Strip, sw: number, sh: number): Fit {
  return { w: strip.w, h: strip.h, x: Math.max(0, (sw - strip.w) / 2), y: Math.max(0, (sh - strip.h) / 2), f: 1 };
}

/** The stage's window onto the strip along its axis, in strip px at scale 1. */
export function viewRange(v: View, fit: Fit, sw: number, sh: number, vertical: boolean): [number, number] {
  const from = vertical ? (-fit.y - v.ty) / v.s : (-fit.x - v.tx) / v.s;
  return [from, from + (vertical ? sh : sw) / v.s];
}

/** Slots overlapping [from, to] along the strip's axis. */
export function slotsIn(strip: Strip, from: number, to: number): Slot[] {
  return strip.slots.filter((s) => {
    const a = strip.vertical ? s.y : s.x;
    const len = strip.vertical ? s.h : s.w;
    return a < to && a + len > from;
  });
}

/** The page under strip offset `c` along the axis; past either end, the
    page at that end. */
export function slotAt(strip: Strip, c: number): number {
  if (!strip.slots.length) return 0;
  let first = strip.slots[0];
  let last = first;
  for (const s of strip.slots) {
    const a = strip.vertical ? s.y : s.x;
    const len = strip.vertical ? s.h : s.w;
    if (c >= a && c < a + len) return s.i;
    if (a < (strip.vertical ? first.y : first.x)) first = s;
    if (a > (strip.vertical ? last.y : last.x)) last = s;
  }
  return c < 0 ? first.i : last.i;
}

/** How far into page i the stage's reading-start edge sits, as a fraction
    of the page's extent along the axis (0 = at its start edge; negative /
    over 1 when the page is off screen). Survives a relayout: see viewToSlot. */
export function slotAnchor(strip: Strip, i: number, v: View, fit: Fit, sw: number, sh: number, mode: Mode): number {
  const slot = strip.slots[i] ?? strip.slots[0];
  const [from, to] = viewRange(v, fit, sw, sh, strip.vertical);
  if (mode === "vertical") return (from - slot.y) / slot.h;
  if (mode === "rtl") return (slot.x + slot.w - to) / slot.w;
  return (from - slot.x) / slot.w;
}

/** The view that brings page i's reading-start edge (top / left / right for
    RTL) — or the point `frac` of the way into it — to the stage's edge at
    scale s, keeping the cross-axis position. Clamp it before use. */
export function viewToSlot(strip: Strip, i: number, fit: Fit, cur: View, s: number, sw: number, mode: Mode, frac = 0): View {
  const slot = strip.slots[i] ?? strip.slots[0];
  if (mode === "vertical") return { s, tx: cur.tx, ty: -fit.y - (slot.y + frac * slot.h) * s };
  if (mode === "rtl") return { s, tx: sw - fit.x - (slot.x + slot.w - frac * slot.w) * s, ty: cur.ty };
  return { s, tx: -fit.x - (slot.x + frac * slot.w) * s, ty: cur.ty };
}

/** Page index after a turn of `delta`, clamped; null when already at the end. */
export function turnPage(i: number, count: number, delta: 1 | -1): number | null {
  const j = i + delta;
  return j < 0 || j >= count ? null : j;
}
