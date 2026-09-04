// The any-word gloss popup, shared by the player's subtitle overlay and the
// page reader. One card: word + reading, the mark cycle (marks land in the
// shared tap store), inflection breakdown, compound hits, curated gloss/notes,
// JMdict senses, and the line's curated grammar/phrase context. Extracted
// from player.ts so the reader shows the exact same popup for the same tap.

import { compoundKeysAt } from "./compounds";
import { inflectionAt } from "./inflection";
import { rubyWord, segsNode } from "./prep-render";
import { cycleTap, getTaps } from "./store";
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
  m === "k" ? "known ✓" : m === "h" ? "interest ★" : "mark";

export function createGlossPopup(opts: GlossPopupOptions): GlossPopup {
  const pop = el("div", `gloss-pop${opts.extraClass ? ` ${opts.extraClass}` : ""}`);
  pop.style.display = "none";
  pop.addEventListener("click", (e) => e.stopPropagation()); // reading ≠ dismiss

  const show = (lemma: string, ti?: number, sentence?: PopupSentence) => {
    const info = opts.keywords?.().get(lemma);
    const defs = opts.defs();
    const entries = defs[lemma] ?? [];
    pop.textContent = "";
    const head = el("div", "gp-head");
    head.appendChild(rubyWord(lemma, info?.entry.reading ?? entries[0]?.r[0]));
    const local = getTaps(opts.episodeId)[lemma];
    const standing = local === undefined && opts.interest?.().has(lemma) ? "h" : local;
    const mark = el("button", "gp-mark", markLabel(standing)) as HTMLButtonElement;
    mark.addEventListener("click", (e) => {
      e.stopPropagation();
      mark.textContent = markLabel(cycleTap(opts.episodeId, lemma));
      opts.onMarkChanged?.();
    });
    head.appendChild(mark);
    pop.appendChild(head);
    // how the tapped word is conjugated HERE — deterministic from the
    // token chain (inflection.ts), so it works on every line, not just
    // curated ones
    const lineTokens = sentence?.tokens ?? [];
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
      pop.appendChild(row);
    }
    // compounds/expressions this token is part of (帝王切開, そういう) —
    // the server pre-validated the runs; we just probe the joined keys
    const compounds = (ti != null ? compoundKeysAt(lineTokens, ti) : [])
      .filter((k) => k !== lemma && defs[k])
      .slice(0, 2);
    for (const key of compounds) {
      const d = el("div", "gp-dict gp-compound");
      d.appendChild(el("span", "gp-tag", "compound"));
      d.appendChild(el("span", "gp-pattern", key));
      const entry = defs[key][0];
      if (entry.r[0] && entry.r[0] !== key)
        d.appendChild(el("span", "gp-reading", ` ${entry.r[0]}`));
      for (const sense of entry.s.slice(0, 2)) {
        const line = el("div", "gp-sense");
        if (sense.pos.length) line.appendChild(el("span", "gp-pos", sense.pos[0]));
        line.appendChild(document.createTextNode(sense.g.slice(0, 4).join("; ")));
        d.appendChild(line);
      }
      pop.appendChild(d);
    }
    // the curate pass's own gloss/note/why lead — they're episode-specific
    if (info?.entry.gloss) pop.appendChild(el("div", "gp-gloss", info.entry.gloss));
    if (info?.entry.note_segs?.length) {
      const note = el("div", "gp-note");
      note.appendChild(segsNode(info.entry.note_segs));
      pop.appendChild(note);
    }
    if (info?.why?.length) {
      const why = el("div", "gp-why");
      why.appendChild(segsNode(info.why));
      pop.appendChild(why);
    }
    // dictionary senses (capped — this is a glance, not a dictionary page)
    for (const entry of entries.slice(0, 2)) {
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
      pop.appendChild(d);
    }
    // the line's curated grammar patterns + phrases (GRAMMAR.md) — they
    // belong to the sentence, not one token, so any word tap surfaces them
    for (const g of sentence?.grammar ?? []) {
      const row = el("div", "gp-line-note");
      row.appendChild(el("span", "gp-tag", g.proposed ? "grammar?" : "grammar"));
      // in the ledger's think-you-know queue → the same blue as a word there
      const ask = opts.grammarConfirm?.().has(g.pattern);
      row.appendChild(el("span", `gp-pattern${ask ? " know" : ""}`, g.pattern));
      if (ask) row.appendChild(el("span", "gp-ask", " · think you know this?"));
      if (g.note) row.appendChild(document.createTextNode(` — ${g.note}`));
      pop.appendChild(row);
    }
    for (const p of sentence?.phrases ?? []) {
      const row = el("div", "gp-line-note");
      row.appendChild(el("span", "gp-tag", "phrase"));
      row.appendChild(el("span", "gp-pattern", p.canonical));
      if (p.surface && p.surface !== p.canonical)
        row.appendChild(document.createTextNode(` — here: ${p.surface}`));
      pop.appendChild(row);
    }
    if (!info && !entries.length && !infl && !compounds.length &&
        !sentence?.grammar?.length && !sentence?.phrases?.length)
      pop.appendChild(el("div", "gp-none", "no dictionary entry"));
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
