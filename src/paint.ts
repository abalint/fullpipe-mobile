// Live paint state (server GET /episodes/{id}/paint). The sidecars the app
// caches freeze two things: each token's `k` (known) flag — set when Stage-1
// coverage ran on the PC — and the standing lists (`confirm`, `interest`)
// as of the moment the transcript was pulled. Neither moves afterwards, so
// a word you marked known in one show kept painting unknown in the next,
// and words that entered the think-you-know queue later never went blue.
// This module overlays the ledger's *current* lists on whatever is cached:
// fetched per episode (tiny — narrowed to its lemmas), kept in localStorage
// for offline reopen, and topped up with every word tapped known on this
// phone (instant, needs no server). Known is additive except for the ✗
// axis — a word marked unknown (here, or on the ledger: `unknown`) is taken
// back OUT of known, the sidecar's frozen `k` notwithstanding; the confirm /
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
import { compoundRunsAt } from "./compounds";
import { getMarkJournal, getTaps, phraseTapKey, splitTapKey } from "./store";
import type { TapKeyKind } from "./store";
import type { PaintState, SentenceGrammar, SentencePhrase, TapMark, Token, TranscriptDoc,
  LookupList,
} from "./types";

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
function locallyMarked(mark: TapMark, kind: TapKeyKind = "word"): Set<string> {
  const out = new Set<string>();
  // word, phrase and grammar marks share the stores but never the paint: a
  // phrase key ("p:" + headword) or grammar key ("g:" + pattern, store.ts)
  // only ever paints its own span
  const take = (key: string, m: string) => {
    const { kind: k, item } = splitTapKey(key);
    if (m !== mark || k !== kind) return;
    out.add(item);
  };
  // the journal holds the LATEST mark per key, so it outranks a stale mark
  // still sitting in an unfinished episode's store (✓ there, ✗ since)
  const journal = getMarkJournal();
  for (const [key, m] of Object.entries(journal)) take(key, m);
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (!k.startsWith("fp.taps.")) continue;
    try {
      const taps = JSON.parse(localStorage.getItem(k) || "{}") as Record<string, string>;
      for (const [key, m] of Object.entries(taps)) if (!(key in journal)) take(key, m);
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

/** Every lemma currently marked unknown (✗) in any episode's tap store. */
export function locallyUnknown(): Set<string> {
  return locallyMarked("u");
}

// ---- phrases: the second axis ---------------------------------------------------
// A phrase (GRAMMAR.md) is its own ledger item: 血が騒ぐ can be unknown while
// 血 / が / 騒ぐ are all known, and that gap is invisible in a word-level
// paint. So each phrase span paints from its OWN state — a local mark on the
// phrase, else the live paint state's phrase lists, else the sidecar's
// status snapshot — never from its tokens'.

export interface PhraseLists {
  known: ReadonlySet<string>;
  confirm: ReadonlySet<string>;
  interest: ReadonlySet<string>;
  /** The live state carried a phrase axis — its `known` is then the truth
      and the sidecar's status snapshot is ignored. */
  live: boolean;
}

export const NO_PHRASES: PhraseLists = {
  known: new Set(),
  confirm: new Set(),
  interest: new Set(),
  live: false,
};

/** Phrase paint lists: the server's (when the paint state has the phrase
    axis) plus this phone's own phrase marks; a ✓ retires a ★, and a
    graduation to blue or known ends a stale local ★. */
export function phraseListsFor(state: PaintState | null): PhraseLists {
  const known = locallyMarked("k", "phrase");
  for (const p of state?.phrase_known ?? []) known.add(p);
  for (const p of locallyMarked("u", "phrase")) known.delete(p);
  const confirm = new Set(state?.phrase_confirm ?? []);
  const interest = locallyMarked("h", "phrase");
  for (const p of state?.phrase_interest ?? []) interest.add(p);
  for (const p of known) interest.delete(p);
  for (const p of confirm) interest.delete(p);
  return { known, confirm, interest, live: state?.phrase_known != null };
}

// ---- grammar: the third axis ---------------------------------------------------
// A grammar point (GRAMMAR.md — token-anchored units) is its own ledger item
// too: 〜てしまう can be unknown while 食べる and て are known. The server
// places each pattern's span on the line (the attachment's tokens), and the
// span paints from the PATTERN's state — a local mark, else the live paint
// state's grammar lists, else the sidecar's status snapshot. The same
// PhraseLists shape serves, since the rules are the same.

export type GrammarLists = PhraseLists;
export const NO_GRAMMAR: GrammarLists = NO_PHRASES;

/** Grammar paint lists: the server's (when the paint state carries the
    grammar axis) plus this phone's own grammar marks; a ✓ retires a ★, a
    ✗ takes the pattern back out of known, and graduation to the queue or
    to known ends a stale local ★. */
export function grammarListsFor(state: PaintState | null): GrammarLists {
  const known = locallyMarked("k", "grammar");
  for (const g of state?.grammar_known ?? []) known.add(g);
  for (const g of locallyMarked("u", "grammar")) known.delete(g);
  for (const g of state?.grammar_unknown ?? []) if (!locallyMarked("k", "grammar").has(g)) known.delete(g);
  const confirm = new Set(state?.grammar_confirm ?? []);
  for (const g of known) confirm.delete(g);
  const interest = locallyMarked("h", "grammar");
  for (const g of state?.grammar_interest ?? []) interest.add(g);
  for (const g of known) interest.delete(g);
  for (const g of confirm) interest.delete(g);
  return { known, confirm, interest, live: state?.grammar_known != null };
}

/** A grammar unit's paint state — the same four states as a phrase
    (phraseClass), read off the pattern: local mark › live lists › the
    sidecar's status snapshot › unknown. */
export function grammarClass(
  g: SentenceGrammar,
  mark: TapMark | undefined,
  lists: GrammarLists,
): "ph-known" | "ph-know" | "ph-int" | "ph-unk" {
  if (mark === "k") return "ph-known";
  if (mark === "h") return "ph-int";
  if (mark === "u") return "ph-unk";
  if (lists.known.has(g.pattern)) return "ph-known";
  if (lists.confirm.has(g.pattern)) return "ph-know";
  if (lists.interest.has(g.pattern)) return "ph-int";
  if (!lists.live && g.status === "known") return "ph-known";
  return "ph-unk";
}

/** The grammar units whose token span covers token `ti` (placed units
    only — a curate-tagged pattern without a span is a line note). */
export function grammarAt(grammar: SentenceGrammar[] | undefined, ti: number): SentenceGrammar[] {
  return (grammar ?? []).filter((g) =>
    g.start != null && g.end != null && ti >= g.start && ti < g.end);
}

export function samePhraseLists(a: PhraseLists, b: PhraseLists): boolean {
  const same = (x: ReadonlySet<string>, y: ReadonlySet<string>) =>
    x.size === y.size && [...x].every((l) => y.has(l));
  return same(a.known, b.known) && same(a.confirm, b.confirm) &&
    same(a.interest, b.interest) && a.live === b.live;
}

/** A phrase span's state, which the player maps onto the WORD hues (a
    phrase paints as one word): ph-known (no colour — known is the absence
    of paint), ph-know (blue, think you know), ph-int (purple ★), ph-unk
    (orange, you don't know it as a unit). `mark` is the phone's own mark on
    the phrase; a ✓ / ★ / ✗ wins, then the ledger. */
export function phraseClass(
  p: SentencePhrase,
  mark: TapMark | undefined,
  lists: PhraseLists,
): "ph-known" | "ph-know" | "ph-int" | "ph-unk" {
  if (mark === "k") return "ph-known";
  if (mark === "h") return "ph-int";
  if (mark === "u") return "ph-unk";
  if (lists.known.has(p.canonical)) return "ph-known";
  if (lists.confirm.has(p.canonical)) return "ph-know";
  if (lists.interest.has(p.canonical)) return "ph-int";
  if (!lists.live && p.status === "known") return "ph-known";
  return "ph-unk";
}

/** The phrases whose token span covers token `ti`. Phrases the server could
    not place (no span — old sidecars, or a surface the tokens don't spell)
    are included only when `unplaced` is set: the popup still offers them
    from any word on the line, the painter has nothing to underline. */
export function phrasesAt(
  phrases: SentencePhrase[] | undefined,
  ti: number,
  unplaced = false,
): SentencePhrase[] {
  return (phrases ?? []).filter((p) =>
    p.start != null && p.end != null ? ti >= p.start && ti < p.end : unplaced,
  );
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

/** What a word is painted as at the moment its popup opens, for the lookup
    count (store.ts recordLookup): known (the live `k` flag) first — a known
    word is on no list — then the list it sits on, else plain. */
export function lookupListOf(
  lemma: string | undefined,
  lists: PaintLists,
  known: boolean,
): LookupList {
  if (known) return "known";
  const cls = listClass(lemma, lists);
  return cls === "hl-know" ? "confirm" : cls === "hl-int" ? "interest"
    : cls === "hl-sk" ? "should_know" : "none";
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
    we have one) plus everything tapped known here, minus every ✗ — the
    phone's own (its latest mark on the word) or the ledger's. */
export function knownFor(state: PaintState | null): Set<string> {
  const s = locallyKnown();
  for (const l of state?.known ?? []) s.add(l);
  for (const l of unknownFor(state)) s.delete(l);
  return s;
}

/** The set to take back OUT of known: every ✗ on this phone plus the
    ledger's ✗'d words, minus a ✓ made here since (the phone's mark is the
    newer one until it syncs). This is the only paint that undoes the
    sidecar's frozen token `k`. */
export function unknownFor(state: PaintState | null): Set<string> {
  const s = locallyUnknown();
  for (const l of state?.unknown ?? []) s.add(l);
  for (const l of locallyKnown()) s.delete(l);
  return s;
}

/** Flip tokens' known flag in place: to known for `known` lemmas, back to
    unknown for `unknown` ones. Returns how many changed, so callers can
    skip a repaint when nothing moved. */
export function applyKnown(
  sentences: Iterable<{ tokens?: Token[] }>,
  known: ReadonlySet<string>,
  unknown: ReadonlySet<string> = new Set(),
): number {
  let n = 0;
  for (const s of sentences) {
    for (const t of s.tokens ?? []) {
      if (!t.l) continue;
      if (!t.k && known.has(t.l)) {
        t.k = true;
        n++;
      } else if (t.k && unknown.has(t.l)) {
        t.k = false;
        n++;
      }
    }
  }
  return n;
}

/** applyKnown from a paint state: known in, ✗'d back out. */
export function applyPaintKnown(
  sentences: Iterable<{ tokens?: Token[] }>,
  state: PaintState | null,
): number {
  return applyKnown(sentences, knownFor(state), unknownFor(state));
}

/** The think-you-know list: the live state's when we have it, else the
    sidecar's snapshot. */
export function confirmFrom(
  state: PaintState | null,
  doc: TranscriptDoc | null | undefined,
): ReadonlySet<string> {
  return state ? new Set(state.confirm) : confirmList(doc);
}

/** The phrase to paint under token `ti`: a curated/tracked phrase whose span
    covers it, else a compound run (compounds.ts — a JMdict multi-token
    headword the dictionary pass found) that the user has MARKED or the
    ledger tracks. Unmarked compounds never paint: そういう / という on every
    line would be noise, and the ledger only tracks what was deliberately
    kept. Longest run wins. */
export function phraseToPaint(
  phrases: SentencePhrase[] | undefined,
  tokens: Token[] | undefined,
  ti: number,
  episodeId: string,
  lists: PhraseLists,
): SentencePhrase | undefined {
  const placed = phrasesAt(phrases, ti)[0];
  if (placed) return placed;
  if (!tokens) return undefined;
  const taps = getTaps(episodeId);
  for (const r of compoundRunsAt(tokens, ti)) {
    if (taps[phraseTapKey(r.key)] || lists.known.has(r.key) ||
        lists.confirm.has(r.key) || lists.interest.has(r.key))
      return { canonical: r.key, start: r.start, end: r.end };
  }
  return undefined;
}
