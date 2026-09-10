// Token / ruby markup shared by the player's subtitle overlay, the gloss
// popup and the page reader — what survives of the prep-doc renderer (the
// prep page itself went 2026-09-10; the player holds the synopsis now).
// Reading rules: ruby only where kanji needs glossing.

import type { Segs, Token } from "./types";

const HAS_KANJI = /[㐀-鿿々〆]/;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const kataToHira = (s: string): string =>
  s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const isKana = (c: string): boolean => /[ぁ-ゖァ-ヶー]/.test(c);

function rubyNode(text: string, reading: string): HTMLElement {
  const r = document.createElement("ruby");
  r.appendChild(document.createTextNode(text));
  const rt = document.createElement("rt");
  rt.textContent = reading;
  r.appendChild(rt);
  return r;
}

export function rubyWord(text: string, reading?: string | null): Node {
  if (!(reading && HAS_KANJI.test(text) && reading !== text))
    return document.createTextNode(text);
  // Furigana over the kanji core only (mirrors engine/lemma.furigana on the
  // PC): peel matching leading/trailing okurigana off surface and reading so
  // 切ない renders 切[せつ]ない, not [切ない|せつない]. Applied at render time
  // so it also repairs whole-word readings in old sidecars/segs payloads.
  let s = text;
  let r = kataToHira(reading);
  let head = "";
  let tail = "";
  while (s && r && isKana(s[s.length - 1]) && kataToHira(s[s.length - 1]) === r[r.length - 1]) {
    tail = s[s.length - 1] + tail;
    s = s.slice(0, -1);
    r = r.slice(0, -1);
  }
  while (s && r && isKana(s[0]) && kataToHira(s[0]) === r[0]) {
    head += s[0];
    s = s.slice(1);
    r = r.slice(1);
  }
  if (!(s && r && HAS_KANJI.test(s)))
    return rubyNode(text, reading); // no clean kanji core — whole-word ruby
  if (!head && !tail) return rubyNode(s, r);
  const frag = document.createDocumentFragment();
  if (head) frag.appendChild(document.createTextNode(head));
  frag.appendChild(rubyNode(s, r));
  if (tail) frag.appendChild(document.createTextNode(tail));
  return frag;
}

// exported for the player's keyword-gloss popup (notes are ruby-annotated)
export function segsNode(segs?: Segs): DocumentFragment {
  const frag = document.createDocumentFragment();
  (segs || []).forEach(([text, reading]) => frag.appendChild(rubyWord(text, reading)));
  return frag;
}

// Nothing lookup-worthy: punctuation, symbols, bare digits, whitespace.
// Doubles as the compound-run break (compoundKeysAt) — MUST stay in lockstep
// with the server's RUN_BREAK (tools/jmdict.py), which decides what compound
// keys /definitions serves.
export const NO_LOOKUP = /^[\s0-9０-９]*$|^[^ぁ-ゖァ-ヶー㐀-鿿々〆A-Za-z0-9０-９]+$/;

// exported for the player's subtitle overlay — same markup, same tap classes.
// anyWord: the player popup answers ANY tap (particles, aux verbs, names —
// /definitions now serves every lemma), so every word gets a span there; the
// prep doc keeps its vocab-only tap targets (its taps are know/don't-know
// marks, and marking の "known" is noise).
export function tokenSpan(t: Token, targetLemma: string | null, anyWord = false): Node {
  if (!t.c && !(anyWord && t.l && !NO_LOOKUP.test(t.l)))
    return document.createTextNode(t.s);
  const cls = ["w"];
  if (t.c) {
    if (!t.k) cls.push("unk");
    if (targetLemma && t.l === targetLemma) cls.push("target");
  }
  const n = el("span", cls.join(" "));
  n.appendChild(rubyWord(t.s, t.r));
  if (t.l) n.dataset.lemma = t.l;
  return n;
}
