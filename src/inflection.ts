// Deterministic inflection breakdown for the player's word popup.
//
// The transcript's Sudachi tokens split conjugated predicates into a head +
// an auxiliary chain (抜い|てる, 行か|れ|た, 食べ|させ|られ|た), and the popup
// looks the head up by its dictionary-form lemma — so the one thing the
// popup could NOT explain was the surface the viewer actually heard. This
// module reassembles the chain around a tapped token and labels each link
// from a static lemma table: no POS data (tokens don't carry it), no AI, no
// deinflector — the tokenizer already did the analysis, we just narrate it.
//
// Labels are plain English — what the speaker is doing with the form, never
// a bare linguistics term ("passive/potential" tells a learner nothing).
// The table is honest about ambiguity (れる could be done-to-them / can-do /
// respect; only context disambiguates) and incomplete: an unlisted link ends
// the chain rather than guessing.

import type { Token } from "./types";

/** te-form connectives: glue between a verb and its following auxiliaries. */
const TE = new Set(["て", "で"]);

/** Auxiliary lemmas that always continue a chain (助動詞 + contracted forms
    + masu-stem followers). Labels are PLAIN ENGLISH — say what the speaker
    is doing with the form, never a bare linguistics term. Where a form is
    genuinely ambiguous (れる), say so honestly and let the sentence decide. */
const AUX: Record<string, string> = {
  た: "already happened (past)",
  ます: "polite ending, no extra meaning",
  です: "polite 'is'",
  だ: "plain 'is'",
  ない: "not — makes it negative",
  ぬ: "not — old-style negative (the ん in わからん)",
  れる: "either it's done TO them, they CAN do it, or respect — the sentence decides",
  られる: "either it's done TO them, they CAN do it, or respect — the sentence decides",
  せる: "someone makes (or lets) them do it",
  させる: "someone makes (or lets) them do it",
  たい: "wants to do it",
  たがる: "(someone else) seems to want to do it",
  う: "'let's…' / 'I'll…' — or a guess: 'probably'",
  よう: "'let's…' / 'I'll…' — or a guess: 'probably'",
  まい: "probably won't — or 'I refuse to'",
  らしい: "apparently — heard it somewhere",
  みたい: "looks like / seems like",
  ば: "if it happens",
  てる: "is doing it right now, or is in that state (~ている)",
  でる: "is doing it right now, or is in that state (~でいる)",
  ちゃう: "went and did it — fully done, often 'oops' (~てしまう)",
  じゃう: "went and did it — fully done, often 'oops' (~でしまう)",
  とく: "do it now so it's ready later (~ておく)",
  どく: "do it now so it's ready later (~でおく)",
  すぎる: "does it too much",
  はじめる: "starts doing it",
  つづける: "keeps doing it",
  やすい: "easy to do",
  にくい: "hard to do",
  づらい: "a pain to do",
  らっしゃる: "respectful — an esteemed person is doing it",
};

/** Aux-position verbs: continue a chain only straight after て/で, where
    they are grammar; elsewhere they are ordinary verbs (時間がかかる). */
const AFTER_TE: Record<string, string> = {
  いる: "is doing it right now, or is in that state",
  ある: "someone did it earlier and it's still that way",
  おく: "do it now so it's ready later",
  しまう: "went and did it — fully done, often 'oops'",
  いく: "keeps going from here on / heads away",
  くる: "has been building up to now / comes this way",
  みる: "gives it a try to see",
  くれる: "someone does it FOR me (I'm grateful)",
  もらう: "I get someone to do it for me",
  いただく: "I have someone do it for me (humble, formal)",
  くださる: "someone kindly does it for me (respectful)",
  あげる: "does it for someone else's benefit",
  やる: "does it for someone (casual, downward)",
  おる: "is doing it (humble or dialect いる)",
  ほしい: "wants someone else to do it",
  ござる: "very polite 'is / exists' (ございます)",
};

/** Surface-specific relabels: same lemma, different function. */
const SURFACE_LABELS: Record<string, string> = {
  たら: "if / once that happens",
  だら: "if / once that happens",
};

const inChain = (t: Token | undefined, prev: Token | undefined): boolean => {
  const l = t?.l;
  if (!l) return false;
  if (TE.has(l) || l in AUX) return true;
  return l in AFTER_TE && !!prev?.l && TE.has(prev.l);
};

export interface InflectionPart {
  text: string; // the link as it appears (surface)
  label?: string; // what it does; the head link carries none
}

export interface Inflection {
  surface: string; // the whole conjugated span as heard
  lemma: string; // the head's dictionary form (what the popup looked up)
  parts: InflectionPart[]; // head first, then each labelled link
}

/** Breakdown of the conjugated span around tokens[ti], or null when the tap
    isn't on (part of) an inflected predicate. Tapping mid-chain (the た of
    行かれた) walks back to the head so every word of the span answers the
    same. */
export function inflectionAt(tokens: Token[], ti: number): Inflection | null {
  if (!tokens[ti]?.l) return null;
  let head = ti;
  while (head > 0 && inChain(tokens[head], tokens[head - 1])) head--;
  const t = tokens[head];
  if (!t?.l || inChain(t, undefined)) return null; // chain with no head
  let end = head + 1;
  while (end < tokens.length && inChain(tokens[end], tokens[end - 1])) end++;
  const chain = tokens.slice(head, end);
  // an uninflected head (surface == lemma: パン, 時) followed only by て/で
  // is noun+particle, not a te-form — trim the dangling link
  while (chain.length > 1 && t.s === t.l && TE.has(chain[chain.length - 1].l!))
    chain.pop();
  if (head + chain.length <= ti) return null; // tap fell on a trimmed link
  if (chain.length === 1 && t.s === t.l) return null; // nothing to explain
  const parts: InflectionPart[] = [{ text: t.l }];
  for (const c of chain.slice(1))
    parts.push({
      text: c.s,
      label:
        SURFACE_LABELS[c.s] ??
        AUX[c.l!] ??
        AFTER_TE[c.l!] ??
        (TE.has(c.l!) ? "connects to the next part" : undefined),
    });
  return { surface: chain.map((c) => c.s).join(""), lemma: t.l, parts };
}
