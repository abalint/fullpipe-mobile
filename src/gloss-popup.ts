// The any-word gloss popup, shared by the player's subtitle overlay and the
// page reader. One card in two layers: the PHRASE layer first, when the
// tapped token sits inside a multi-word expression (血が騒いだ — GRAMMAR.md:
// its own ledger item, with its own mark, reading and JMdict senses), then
// the WORD layer — word + reading, the mark cycle (marks land in the shared
// tap store), inflection breakdown, compound hits, curated gloss/notes,
// JMdict senses — and the line's other curated grammar/phrase context at the
// foot. The two marks are independent: every word in 血が騒ぐ can be known
// while the phrase itself is not, and the card makes that gap visible.
// Extracted from player.ts so the reader shows the exact same popup for the
// same tap.

import { compoundRunsAt } from "./compounds";
import { inflectionAt } from "./inflection";
import { NO_PHRASES, phrasesAt } from "./paint";
import type { PhraseLists } from "./paint";
import { rubyWord, segsNode } from "./prep-render";
import { cycleTap, getTaps, phraseTapKey } from "./store";
import type {
  Definitions,
  GlossEntry,
  Segs,
  SentenceGrammar,
  SentencePhrase,
  TapMark,
  Token,
} from "./types";

/** What the popup knows about a curated word: its glossary row + the focal
    point's "why", when the curate pass flagged it. */
export interface KeywordInfo {
  entry: GlossEntry;
  why?: Segs;
}

/** The tapped token's sentence context: tokens for the inflection/compound
    lookups, curated grammar/phrases for the line notes. The player passes the
    current cue; the reader passes the tapped sentence. */
export interface PopupSentence {
  tokens?: Token[];
  grammar?: SentenceGrammar[];
  phrases?: SentencePhrase[];
}

export interface GlossPopupOptions {
  /** Curated grammar patterns awaiting the user's confirm (paint.ts) — the
      line note paints them blue. */
  grammarConfirm?: () => ReadonlySet<string>;
  /** The standing high-interest set (paint.ts interestFor) — a word starred
      in another episode shows "interest ★" here too; the next tap is ✓. */
  interest?: () => ReadonlySet<string>;
  /** The phrase axis (paint.ts phraseListsFor) — a phrase starred or in the
      think-you-know queue shows as such in its layer. */
  phrases?: () => PhraseLists;
  episodeId: string;
  /** Live getters — defs/keywords load async and refresh after the popup is
      built, so the popup reads them at show() time, never at create() time. */
  defs(): Definitions;
  keywords?(): Map<string, KeywordInfo>;
  /** Fired after the mark button cycles, so the host can repaint its spans. */
  onMarkChanged?(): void;
  /** Extra class on the card — "fixed" pins it above the bottom nav (the
      reader's scrolling page has no stage to anchor to). */
  extraClass?: string;
}

export interface GlossPopup {
  el: HTMLElement;
  show(lemma: string, ti?: number, sentence?: PopupSentence): void;
  hide(): void;
  readonly visible: boolean;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const markLabel = (m: TapMark | undefined) =>
  m === "k" ? "known ✓" : m === "h" ? "interest ★" : m === "u" ? "unknown ✗" : "mark";

export function createGlossPopup(opts: GlossPopupOptions): GlossPopup {
  const pop = el("div", `gloss-pop${opts.extraClass ? ` ${opts.extraClass}` : ""}`);
  pop.style.display = "none";
  pop.addEventListener("click", (e) => e.stopPropagation()); // reading ≠ dismiss

  /** The mark button for one item — a word (key = lemma) or a phrase (key =
      store.ts phraseTapKey). `standing` is the ledger's ★ when the phone has
      no mark of its own, so the label reads "interest ★" and the next tap
      is the ✓ that graduates it. */
  const markButton = (key: string, standing: boolean): HTMLButtonElement => {
    const local = getTaps(opts.episodeId)[key];
    const shown = local === undefined && standing ? "h" : local;
    const mark = el("button", "gp-mark", markLabel(shown)) as HTMLButtonElement;
    mark.addEventListener("click", (e) => {
      e.stopPropagation();
      mark.textContent = markLabel(cycleTap(opts.episodeId, key));
      opts.onMarkChanged?.();
    });
    return mark;
  };

  /** Dictionary senses for one key (capped — this is a glance, not a
      dictionary page). `skipFirstReading`: the head already shows it. */
  const senses = (defs: Definitions, key: string, max: number): HTMLElement[] => {
    const entries = defs[key] ?? [];
    return entries.slice(0, max).map((entry) => {
      const d = el("div", "gp-dict");
      // curate-authored definition (word JMdict lacks) — label the source
      if (entry.ai) d.appendChild(el("span", "gp-tag", "curated"));
      // header already shows the first entry's reading
      if (entry !== entries[0]) d.appendChild(el("span", "gp-reading", entry.r[0] ?? ""));
      for (const sense of entry.s.slice(0, 3)) {
        const line = el("div", "gp-sense");
        if (sense.pos.length) line.appendChild(el("span", "gp-pos", sense.pos[0]));
        line.appendChild(document.createTextNode(sense.g.slice(0, 4).join("; ")));
        d.appendChild(line);
      }
      return d;
    });
  };

  /** The phrase layer: the expression as its own item — head (tag, ruby
      headword, its own mark), how it surfaces on this line, its senses. */
  const phraseLayer = (p: SentencePhrase, defs: Definitions): HTMLElement => {
    const layer = el("div", "gp-layer gp-phrase");
    layer.dataset.phrase = p.canonical;
    const head = el("div", "gp-head");
    head.appendChild(el("span", "gp-tag", "phrase"));
    head.appendChild(rubyWord(p.canonical, defs[p.canonical]?.[0]?.r[0]));
    const lists = opts.phrases?.() ?? NO_PHRASES;
    head.appendChild(markButton(phraseTapKey(p.canonical), lists.interest.has(p.canonical)));
    layer.appendChild(head);
    if (p.surface && p.surface !== p.canonical) {
      const row = el("div", "gp-inflect");
      row.appendChild(el("span", "gp-surface", p.surface));
      row.appendChild(document.createTextNode(" ＝ "));
      row.appendChild(el("span", "gp-part", p.canonical));
      layer.appendChild(row);
    }
    const dict = senses(defs, p.canonical, 2);
    if (dict.length) layer.append(...dict);
    else layer.appendChild(el("div", "gp-none", "no dictionary entry"));
    return layer;
  };

  const show = (lemma: string, ti?: number, sentence?: PopupSentence) => {
    const info = opts.keywords?.().get(lemma);
    const defs = opts.defs();
    const entries = defs[lemma] ?? [];
    pop.textContent = "";
    // --- phrase layer(s): the expression the tapped token sits inside.
    // Phrases the painter couldn't place (no span) stay foot notes below,
    // with their own mark, so every phrase on the line is still markable.
    const covering = ti != null ? phrasesAt(sentence?.phrases, ti) : [];
    const inPhrase = new Set(covering.map((p) => p.canonical));
    // compounds/expressions this token is part of (帝王切開, そういう,
    // 百歩譲って) — the server pre-validated the runs as JMdict headwords
    // (tools/jmdict.py compound_entries), which makes each one a phrase key
    // in its own right (GRAMMAR.md), so it gets the same layer and mark
    const lineTokens = sentence?.tokens ?? [];
    for (const r of ti != null ? compoundRunsAt(lineTokens, ti) : []) {
      if (r.key === lemma || !defs[r.key] || inPhrase.has(r.key)) continue;
      if (covering.length >= 3) break; // a glance, not a dictionary page
      inPhrase.add(r.key);
      covering.push({
        canonical: r.key,
        surface: lineTokens.slice(r.start, r.end).map((t) => t.s).join(""),
        start: r.start,
        end: r.end,
      });
    }
    for (const p of covering) pop.appendChild(phraseLayer(p, defs));

    // --- word layer
    const word = el("div", "gp-layer gp-word");
    const head = el("div", "gp-head");
    if (covering.length) head.appendChild(el("span", "gp-tag", "word"));
    head.appendChild(rubyWord(lemma, info?.entry.reading ?? entries[0]?.r[0]));
    head.appendChild(markButton(lemma, !!opts.interest?.().has(lemma)));
    word.appendChild(head);
    // how the tapped word is conjugated HERE — deterministic from the
    // token chain (inflection.ts), so it works on every line, not just
    // curated ones
    const infl = ti != null ? inflectionAt(lineTokens, ti) : null;
    if (infl && (infl.parts.length > 1 || infl.surface !== infl.lemma)) {
      const row = el("div", "gp-inflect");
      row.appendChild(el("span", "gp-surface", infl.surface));
      row.appendChild(document.createTextNode(" ＝ "));
      infl.parts.forEach((p, i) => {
        if (i) row.appendChild(document.createTextNode(" ＋ "));
        row.appendChild(el("span", "gp-part", p.text));
        if (p.label) row.appendChild(el("span", "gp-part-label", `〔${p.label}〕`));
      });
      word.appendChild(row);
    }
    // the curate pass's own gloss/note/why lead — they're episode-specific
    if (info?.entry.gloss) word.appendChild(el("div", "gp-gloss", info.entry.gloss));
    if (info?.entry.note_segs?.length) {
      const note = el("div", "gp-note");
      note.appendChild(segsNode(info.entry.note_segs));
      word.appendChild(note);
    }
    if (info?.why?.length) {
      const why = el("div", "gp-why");
      why.appendChild(segsNode(info.why));
      word.appendChild(why);
    }
    // dictionary senses
    word.append(...senses(defs, lemma, 2));
    // the line's curated grammar patterns + the phrases the tap is NOT
    // inside (GRAMMAR.md) — they belong to the sentence, not one token, so
    // any word tap surfaces them
    for (const g of sentence?.grammar ?? []) {
      const row = el("div", "gp-line-note");
      row.appendChild(el("span", "gp-tag", g.proposed ? "grammar?" : "grammar"));
      // in the ledger's think-you-know queue → the same blue as a word there
      const ask = opts.grammarConfirm?.().has(g.pattern);
      row.appendChild(el("span", `gp-pattern${ask ? " know" : ""}`, g.pattern));
      if (ask) row.appendChild(el("span", "gp-ask", " · think you know this?"));
      if (g.note) row.appendChild(document.createTextNode(` — ${g.note}`));
      word.appendChild(row);
    }
    for (const p of sentence?.phrases ?? []) {
      if (inPhrase.has(p.canonical)) continue;
      const row = el("div", "gp-line-note gp-line-phrase");
      row.appendChild(el("span", "gp-tag", "phrase"));
      row.appendChild(el("span", "gp-pattern", p.canonical));
      if (p.surface && p.surface !== p.canonical)
        row.appendChild(document.createTextNode(` — here: ${p.surface}`));
      const lists = opts.phrases?.() ?? NO_PHRASES;
      row.appendChild(markButton(phraseTapKey(p.canonical), lists.interest.has(p.canonical)));
      word.appendChild(row);
    }
    if (!info && !entries.length && !infl && !covering.length &&
        !sentence?.grammar?.length && !sentence?.phrases?.length)
      word.appendChild(el("div", "gp-none", "no dictionary entry"));
    pop.appendChild(word);
    pop.style.display = "";
    pop.scrollTop = 0; // the card scrolls when clamped — don't inherit the last word's position
  };

  return {
    el: pop,
    show,
    hide: () => (pop.style.display = "none"),
    get visible() {
      return pop.style.display !== "none";
    },
  };
}
