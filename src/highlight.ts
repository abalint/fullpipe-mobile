// Word-level highlighting, shared by the player's subtitle overlay and the
// manga reader's bubble overlay: one routine decides what a token span is
// painted as, so a word reads the same on a page as under the video.
//
// The paints (LIVE_REVIEW.md §6): known = nothing (absence is the signal),
// blue = think you know, purple = high interest ★, green = should know
// (the most frequent unknowns), pink = high value here (a curated keyword —
// dotted, tap for its gloss — or a ranked candidate), orange = you don't
// know this (the i+1 target underlined). Tiered: off / focus (the global
// lists + pink + the target) / learn (+ every unknown in orange). The
// three global lists are facts about the user, not the episode, so they
// paint at any tier but off and outrank the episode-local hues.
//
// Two axes ride over the words (GRAMMAR.md): a phrase span paints as ONE
// word in the PHRASE's state (an unknown expression made of known words
// still shows), and a grammar unit paints from the PATTERN's state with a
// dotted marker that says "attachment, not a word". The surfaces only
// differ in how the classes render (text colour over video, tinted washes
// over art) — style.css carries both.

import type { KeywordInfo } from "./gloss-popup";
import {
  grammarAt,
  grammarClass,
  listClass,
  paintsInterest,
  phraseClass,
  phraseToPaint,
} from "./paint";
import type { GrammarLists, PaintLists, PhraseLists } from "./paint";
import { getTaps, grammarTapKey, phraseTapKey } from "./store";
import type { SentenceGrammar, SentencePhrase, TapMark, Token } from "./types";

/** Highlight intensity: nothing · the global lists + high-value + the i+1
    target · + every unknown word. A global viewing pref like the cc mode. */
export type SubTier = "off" | "focus" | "learn";
export const SUB_TIERS: SubTier[] = ["off", "focus", "learn"];
const SUB_TIER_KEY = "fp.sub.tier";

export const isTier = (v: string | null | undefined): v is SubTier =>
  (SUB_TIERS as string[]).includes(v ?? "");

export function getSubTier(): SubTier {
  const raw = localStorage.getItem(SUB_TIER_KEY);
  // "all" (the retired corpus-audit tier) reads as learn
  return isTier(raw) ? raw : "learn";
}

export function setSubTier(tier: SubTier): void {
  localStorage.setItem(SUB_TIER_KEY, tier);
}

/** The line shape the painter reads: a player cue or a transcript sentence
    (timing and text ride along unused). */
export interface PaintLine {
  cls?: string; // coverage classification (i_plus_1/…) — absent on old sidecars
  tokens?: Token[];
  grammar?: SentenceGrammar[];
  phrases?: SentencePhrase[];
  start?: number;
  end?: number;
  text?: string;
}

/** The one unknown content word on a line, when there is exactly one — the
    i+1 target. */
export function soleUnknown(c: PaintLine): string | null {
  const unk = new Set(
    (c.tokens ?? []).filter((t) => t.c && !t.k && t.l).map((t) => t.l as string),
  );
  return unk.size === 1 ? unk.values().next().value! : null;
}

/** Is this line an i+1 moment? Trust the coverage classification when the
    line carries one; otherwise fall back to "exactly one unknown content
    word" (which then also counts reinforcement lines — acceptable for old
    sidecars). */
export function isIplus1(c: PaintLine): boolean {
  if (c.cls) return c.cls === "i_plus_1";
  return soleUnknown(c) != null;
}

/** Word-level highlight class for a token at a tier, or null.
    Priority: the global lists first — think-you-know (blue) > high interest
    (purple) > should-know (green) — they are facts about the user, not this
    episode, and paint at every tier but off. Then the episode's own:
    curated keyword (pink, dotted) > i+1 target (orange underline — targets
    are usually candidates too, and the i+1 emphasis must win) > high-value
    candidate (pink) > unknown (orange, learn tier only). A reinforcement
    target (still on a young card) is just an unknown here. */
export function tokenHighlight(
  t: Token,
  tier: SubTier,
  keywords: Map<string, KeywordInfo>,
  highValue: Set<string>,
  target: string | null,
  cls?: string,
  lists?: PaintLists,
): string | null {
  if (tier === "off" || !t.c || !t.l) return null;
  const global = lists ? listClass(t.l, lists) : null;
  if (global) return global;
  if (keywords.has(t.l)) return "kw";
  if (t.l === target && cls !== "reinforcement") return "hl-target";
  if (highValue.has(t.l)) return "hl-hv";
  if (tier === "learn" && !t.k) return "hl-unk";
  return null;
}

/** Every class the painter may set — cleared before each repaint. */
export const HL_CLASSES = ["hl-know", "hl-int", "hl-sk", "kw", "hl-hv", "hl-target", "hl-unk", "gr"];
export const TAP_CLASSES = ["tap-k", "tap-h", "tap-u", "tap-committed"];

// a phrase / grammar unit paints like ONE word in the unit's state (user
// rule, 2026-09-05: no separate underline) — its tokens take the word hues
const PHRASE_HL: Record<string, string | null> = {
  "ph-known": null, "ph-know": "hl-know", "ph-int": "hl-int", "ph-unk": "hl-unk",
};

const NO_KEYWORDS: Map<string, KeywordInfo> = new Map();
const NO_HIGH_VALUE: Set<string> = new Set();

/** What the painter needs to know about the sitting, beyond the span. */
export interface PaintContext {
  episodeId: string;
  tier: SubTier;
  lists: PaintLists;
  phraseLists: PhraseLists;
  grammarLists: GrammarLists;
  /** Curated keywords (the prep doc's glossed rows) — pink, dotted. */
  keywords?: Map<string, KeywordInfo>;
  /** The transcript's ranked candidates — pink at focus and above. */
  highValue?: Set<string>;
  /** This phone's marks (store.ts getTaps) — read once per repaint. */
  taps: Record<string, TapMark>;
  /** Marks already sent and unchanged — painted muted (the reading
      surfaces; the player has no unsent/sent distinction on screen). */
  submitted?: Record<string, TapMark>;
}

/** Repaint one word span in place. `line` is the sentence it sits on and
    `ti` its token index there (from the span's data attributes); the span
    keeps its element, so an open popup stays anchored. Order of claims on
    the span: the phrase it sits in › the grammar unit it sits in › the word
    itself. Tap marks layer on top from the unit that owns the span. */
export function paintWordSpan(
  w: HTMLElement,
  line: PaintLine | undefined,
  ti: number | undefined,
  ctx: PaintContext,
): void {
  const lemma = w.dataset.lemma ?? "";
  const { tier, taps } = ctx;
  const t = ti != null ? line?.tokens?.[ti] : undefined;
  w.classList.remove(...HL_CLASSES);
  const marks = (mark: TapMark | undefined, key: string, star: boolean) => {
    w.classList.toggle("tap-k", mark === "k");
    w.classList.toggle("tap-h", star);
    w.classList.toggle("tap-u", mark === "u");
    w.classList.toggle(
      "tap-committed",
      !!ctx.submitted && mark !== undefined && ctx.submitted[key] === mark,
    );
  };
  // the phrase span this token sits in (GRAMMAR.md) is one unit: every
  // token of it paints as if it were that one word, in the PHRASE's state
  const p = ti != null && tier !== "off"
    ? phraseToPaint(line?.phrases, line?.tokens, ti, ctx.episodeId, ctx.phraseLists)
    : undefined;
  if (p) {
    const key = phraseTapKey(p.canonical);
    const pmark = taps[key];
    const hl = PHRASE_HL[phraseClass(p, pmark, ctx.phraseLists)];
    if (hl && (hl !== "hl-unk" || tier === "learn")) w.classList.add(hl);
    marks(pmark, key, pmark === "h");
    w.dataset.phrase = p.canonical;
    delete w.dataset.grammar;
    return;
  }
  delete w.dataset.phrase;
  // the grammar unit this token sits in (token-anchored units) paints from
  // the PATTERN's state, in the word hues plus the "attachment" marker: the
  // てしまっ of 食べてしまった goes blue when 〜てしまう is in the
  // think-you-know queue, whatever 食べる is painted
  const g = ti != null && tier !== "off" ? grammarAt(line?.grammar, ti)[0] : undefined;
  if (g) {
    const key = grammarTapKey(g.pattern);
    const gmark = taps[key];
    const hl = PHRASE_HL[grammarClass(g, gmark, ctx.grammarLists)];
    if (hl && (hl !== "hl-unk" || tier === "learn")) w.classList.add(hl, "gr");
    marks(gmark, key, gmark === "h");
    w.dataset.grammar = g.pattern;
    return;
  }
  delete w.dataset.grammar;
  if (t) {
    const target = line ? soleUnknown(line) : null;
    const hl = tokenHighlight(
      t, tier, ctx.keywords ?? NO_KEYWORDS, ctx.highValue ?? NO_HIGH_VALUE,
      target, line?.cls, ctx.lists,
    );
    if (hl) w.classList.add(hl);
  }
  const mark = taps[lemma];
  marks(mark, lemma, paintsInterest(mark, lemma, ctx.lists.interest));
}

/** Repaint every word span under `root` whose data attributes say which
    line (`data-si`, an index into `lines`) and token (`data-ti`) it is —
    the reading surfaces' whole pass. `lineOf` resolves the span's line
    when the index isn't the sentence list (the player's current cue). */
export function paintWordSpans(
  root: ParentNode,
  lineOf: (w: HTMLElement) => PaintLine | undefined,
  ctx: Omit<PaintContext, "taps"> & { taps?: Record<string, TapMark> },
): void {
  const full: PaintContext = { ...ctx, taps: ctx.taps ?? getTaps(ctx.episodeId) };
  root.querySelectorAll<HTMLElement>(".w[data-lemma]").forEach((w) => {
    const ti = w.dataset.ti != null ? Number(w.dataset.ti) : undefined;
    paintWordSpan(w, lineOf(w), Number.isFinite(ti) ? ti : undefined, full);
  });
}
