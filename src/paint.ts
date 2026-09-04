// Live paint state (server GET /episodes/{id}/paint). The sidecars the app
// caches freeze two things: each token's `k` (known) flag — set when Stage-1
// coverage ran on the PC — and the standing lists (`confirm`, `interest`)
// as of the moment the transcript was pulled. Neither moves afterwards, so
// a word you marked known in one show kept painting unknown in the next,
// and words that entered the think-you-know queue later never went blue.
// This module overlays the ledger's *current* lists on whatever is cached:
// fetched per episode (tiny — narrowed to its lemmas), kept in localStorage
// for offline reopen, and topped up with every word tapped known on this
// phone (instant, needs no server). Known is additive only; the confirm /
// interest / should-know lists and the grammar half of the confirm queue
// replace the sidecar's copies.
//
// The three global lists (LIVE_REVIEW.md) and their paint:
//   confirm     "think you know"   blue    — exposures cleared the bar
//   interest    "high interest" ★  purple  — you starred it, in ANY episode
//   should_know "should know"      green   — the most frequent words not known
// ★ is global: the server's list (tap_interest minus known/graduated) plus
// every ★ in any episode's tap store on this phone — so a word starred in
// one show paints purple in the next before it has even synced. A local ✓
// beats all three (absence of colour IS the known signal).

import { api } from "./api";
import { confirmList } from "./lists";
import { getMarkJournal } from "./store";
import type { PaintState, TapMark, Token, TranscriptDoc } from "./types";

const key = (ep: string) => `fp.paint.${ep}`;

export function getCachedPaint(ep: string): PaintState | null {
  try {
    const raw = localStorage.getItem(key(ep));
    return raw ? (JSON.parse(raw) as PaintState) : null;
  } catch {
    return null;
  }
}

export function cachePaint(ep: string, state: PaintState): void {
  localStorage.setItem(key(ep), JSON.stringify(state));
}

/** Fresh state from the server, cached on success; null when unreachable
    (the caller keeps whatever it painted from the cache). */
export async function fetchPaint(ep: string): Promise<PaintState | null> {
  try {
    const st = await api.getPaint(ep);
    cachePaint(ep, st);
    return st;
  } catch {
    return null;
  }
}

/** Every lemma carrying `mark` on this phone — in the global mark journal
    (store.ts, survives close-out) or any episode's live tap store — so a
    mark made in one show counts everywhere at once, before it has even
    synced. */
function locallyMarked(mark: TapMark): Set<string> {
  const out = new Set<string>();
  for (const [lemma, m] of Object.entries(getMarkJournal())) if (m === mark) out.add(lemma);
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (!k.startsWith("fp.taps.")) continue;
    try {
      const taps = JSON.parse(localStorage.getItem(k) || "{}") as Record<string, string>;
      for (const [lemma, m] of Object.entries(taps)) if (m === mark) out.add(lemma);
    } catch {
      /* a corrupt entry paints nothing */
    }
  }
  return out;
}

/** Every lemma currently marked known (✓) in any episode's tap store. */
export function locallyKnown(): Set<string> {
  return locallyMarked("k");
}

/** Every lemma currently starred (★) in any episode's tap store. */
export function locallyInterest(): Set<string> {
  return locallyMarked("h");
}

/** Snapshot lists a transcript sidecar carries (absent on old sidecars). */
export interface ListSnapshot {
  confirm?: string[];
  interest?: string[];
  should_know?: string[];
}

/** The high-interest set to paint purple: the server's standing list (live
    state, else the sidecar snapshot) plus every ★ on this phone, minus what
    has graduated — ✓'d on this phone, known on the ledger, or promoted to
    the blue think-you-know list (a stale local ★ must not out-paint it). */
export function interestFor(
  state: PaintState | null,
  doc: ListSnapshot | null | undefined,
): Set<string> {
  const s = locallyInterest();
  for (const l of state?.interest ?? doc?.interest ?? []) s.add(l);
  for (const l of state?.known ?? []) s.delete(l);
  for (const l of state?.confirm ?? doc?.confirm ?? []) s.delete(l);
  for (const l of locallyKnown()) s.delete(l);
  return s;
}

/** The should-know set to paint green: the server's window (live state,
    else the sidecar snapshot) minus anything this phone has ✓'d or ★'d —
    a star moves the word to the purple list, a check retires it. */
export function shouldKnowFor(
  state: PaintState | null,
  doc: ListSnapshot | null | undefined,
): Set<string> {
  const s = new Set(state?.should_know ?? doc?.should_know ?? []);
  for (const l of locallyKnown()) s.delete(l);
  for (const l of locallyInterest()) s.delete(l);
  return s;
}

/** The three global lists as one bundle, for the surfaces that paint them. */
export interface PaintLists {
  confirm: ReadonlySet<string>;
  interest: ReadonlySet<string>;
  shouldKnow: ReadonlySet<string>;
}

export const NO_LISTS: PaintLists = {
  confirm: new Set(),
  interest: new Set(),
  shouldKnow: new Set(),
};

export function listsFor(
  state: PaintState | null,
  doc: ListSnapshot | null | undefined,
): PaintLists {
  return {
    confirm: confirmFrom(state, doc as TranscriptDoc | null | undefined),
    interest: interestFor(state, doc),
    shouldKnow: shouldKnowFor(state, doc),
  };
}

export function sameLists(a: PaintLists, b: PaintLists): boolean {
  const same = (x: ReadonlySet<string>, y: ReadonlySet<string>) =>
    x.size === y.size && [...x].every((l) => y.has(l));
  return same(a.confirm, b.confirm) && same(a.interest, b.interest) &&
    same(a.shouldKnow, b.shouldKnow);
}

/** The global-list class for a lemma, in precedence order (blue › purple ›
    green), or null. Local tap marks are layered on top by the surfaces. */
export function listClass(lemma: string | undefined, lists: PaintLists): string | null {
  if (!lemma) return null;
  if (lists.confirm.has(lemma)) return "hl-know";
  if (lists.interest.has(lemma)) return "hl-int";
  if (lists.shouldKnow.has(lemma)) return "hl-sk";
  return null;
}

/** Does this word paint ★? A local ★, or standing interest with no local
    mark — a local ✓ wins (it is the graduation out of the list). */
export function paintsInterest(
  mark: TapMark | undefined,
  lemma: string | undefined,
  interest: ReadonlySet<string>,
): boolean {
  return mark === "h" || (mark === undefined && !!lemma && interest.has(lemma));
}

/** The known set to paint with: the server's list for this episode (when
    we have one) plus everything tapped known here. */
export function knownFor(state: PaintState | null): Set<string> {
  const s = locallyKnown();
  for (const l of state?.known ?? []) s.add(l);
  return s;
}

/** Flip tokens to known in place (additive). Returns how many changed, so
    callers can skip a repaint when nothing moved. */
export function applyKnown(
  sentences: Iterable<{ tokens?: Token[] }>,
  known: ReadonlySet<string>,
): number {
  let n = 0;
  for (const s of sentences) {
    for (const t of s.tokens ?? []) {
      if (!t.k && t.l && known.has(t.l)) {
        t.k = true;
        n++;
      }
    }
  }
  return n;
}

/** The think-you-know list: the live state's when we have it, else the
    sidecar's snapshot. */
export function confirmFrom(
  state: PaintState | null,
  doc: TranscriptDoc | null | undefined,
): ReadonlySet<string> {
  return state ? new Set(state.confirm) : confirmList(doc);
}
