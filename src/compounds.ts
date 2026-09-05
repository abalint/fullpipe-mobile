// Compound / expression lookup keys for the word popup.
//
// Sudachi (SplitMode C) still splits real compounds and expressions into
// adjacent tokens — 帝王切開 → 帝王|切開, そういう → そう|いう, 気を付ける →
// 気|を|付ける — so a tap on a component would only ever show the part's
// meaning. The server scans every sentence for adjacent-token runs whose
// join is a validated JMdict headword and serves those entries in
// /definitions keyed by the joined string (tools/jmdict.py
// compound_entries). This module rebuilds the same candidate keys around a
// tapped token; whichever keys exist in the definitions map are the
// compounds the tapped word is part of.
//
// Key construction MUST stay in lockstep with the server: runs of 2..4
// adjacent tokens that all have a lemma and pass NO_LOOKUP; per run, the
// surface concat and surfaces+final-LEMMA (an inflected tail still finds
// its dictionary form: 気を付けて → 気を付ける). WHICH keys are served is
// the server's call alone (lexical units only — no particle-led grammar
// patterns, no word+glue, no homophones); the popup shows the widest
// served run covering the tap (gloss-popup.ts servedCompoundsAt).

import { NO_LOOKUP } from "./prep-render";
import type { Token } from "./types";

const MAX_RUN = 4; // server's COMPOUND_MAX_TOKENS

/** One candidate compound: its lookup key and the token run [start, end)
    it spans — the span is what lets a marked compound paint as a phrase
    unit (paint.ts) and open the popup's phrase layer. */
export interface CompoundRun {
  key: string;
  start: number;
  end: number;
}

/** Candidate compound runs containing tokens[ti], longest run first (so
    callers rendering the first hits show the widest match); the surface
    key precedes the dictionary-form key for the same run. */
export function compoundRunsAt(tokens: Token[], ti: number): CompoundRun[] {
  const ok = (t: Token | undefined) => !!t?.l && !NO_LOOKUP.test(t.l);
  if (!ok(tokens[ti])) return [];
  const runs: CompoundRun[] = [];
  const seen = new Set<string>();
  const push = (key: string, start: number, end: number) => {
    if (seen.has(key)) return;
    seen.add(key);
    runs.push({ key, start, end });
  };
  for (let len = MAX_RUN; len >= 2; len--) {
    for (let i = ti - len + 1; i <= ti; i++) {
      if (i < 0 || i + len > tokens.length) continue;
      const run = tokens.slice(i, i + len);
      if (!run.every((t) => ok(t))) continue;
      const surf = run.map((t) => t.s).join("");
      const stem = run
        .slice(0, -1)
        .map((t) => t.s)
        .join("")
        .concat(run[len - 1].l!);
      push(surf, i, i + len);
      if (stem !== surf) push(stem, i, i + len);
    }
  }
  return runs;
}

/** Candidate compound keys for runs containing tokens[ti], longest run first. */
export function compoundKeysAt(tokens: Token[], ti: number): string[] {
  return compoundRunsAt(tokens, ti).map((r) => r.key);
}
