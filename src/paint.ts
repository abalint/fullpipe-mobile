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
// interest lists and the grammar half of the confirm queue replace the
// sidecar's copies.

import { api } from "./api";
import { confirmList } from "./lists";
import type { PaintState, Token, TranscriptDoc } from "./types";

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

/** Every lemma currently marked known (✓) in any episode's tap store on
    this phone — a mark made in one show counts everywhere at once, before
    it has even synced. */
export function locallyKnown(): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (!k.startsWith("fp.taps.")) continue;
    try {
      const taps = JSON.parse(localStorage.getItem(k) || "{}") as Record<string, string>;
      for (const [lemma, mark] of Object.entries(taps)) if (mark === "k") out.add(lemma);
    } catch {
      /* a corrupt entry paints nothing */
    }
  }
  return out;
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
