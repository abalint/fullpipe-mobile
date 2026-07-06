// Prep-doc renderer — a TS port of fullPipe/render/template.html, with taps
// backed by the store (per-episode, survives restarts) instead of a page-local
// variable. Same reading rules: ruby only where kanji needs glossing, English
// masked by default so definitions can't bias the self-test.

import type { PrepDoc, Segs, Sentence, Token } from "./types";
import { cycleTap, getSubmitted, getTaps, pendingTapCount } from "./store";

const HAS_KANJI = /[㐀-鿿々〆]/;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function rubyWord(text: string, reading?: string | null): Node {
  if (!(reading && HAS_KANJI.test(text) && reading !== text))
    return document.createTextNode(text);
  const r = document.createElement("ruby");
  r.appendChild(document.createTextNode(text));
  const rt = document.createElement("rt");
  rt.textContent = reading;
  r.appendChild(rt);
  return r;
}

function segsNode(segs?: Segs): DocumentFragment {
  const frag = document.createDocumentFragment();
  (segs || []).forEach(([text, reading]) => frag.appendChild(rubyWord(text, reading)));
  return frag;
}

function tokenSpan(t: Token, targetLemma: string | null): Node {
  if (!t.c) return document.createTextNode(t.s);
  const cls = ["w"];
  if (!t.k) cls.push("unk");
  if (targetLemma && t.l === targetLemma) cls.push("target");
  const n = el("span", cls.join(" "));
  n.appendChild(rubyWord(t.s, t.r));
  if (t.l) n.dataset.lemma = t.l;
  return n;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function sentenceCard(
  s: Sentence,
  targetLemma: string | null,
  onSeek?: (sec: number) => void,
): HTMLElement {
  const card = el("div", "sent");
  const time = el("div", "time", fmtTime(s.start));
  if (onSeek) {
    time.classList.add("seek");
    time.addEventListener("click", () => onSeek(s.start));
  }
  card.appendChild(time);
  const body = el("div");
  s.tokens.forEach((t) => body.appendChild(tokenSpan(t, targetLemma)));
  card.appendChild(body);
  return card;
}

export interface PrepRenderOptions {
  /** Seek the player to a sentence timestamp (omitted → timestamps inert). */
  onSeek?: (sec: number) => void;
  /** Called after every tap change with the count of *unsent* changes (marks
      differing from the last submit) — e.g. to refresh a submit-button badge. */
  onTapsChanged?: (pending: number) => void;
  /** Receives the renderer's tap-repaint fn so the caller can re-sync marks
      (e.g. after a submit re-styles them as committed). */
  registerRefresh?: (refresh: () => void) => void;
}

export function renderPrep(doc: PrepDoc, opts: PrepRenderOptions = {}): HTMLElement {
  const root = el("div", "prep");
  const epId = doc.episode.id;

  const refreshTapClasses = () => {
    const taps = getTaps(epId);
    const submitted = getSubmitted(epId);
    root.querySelectorAll<HTMLElement>(".w[data-lemma]").forEach((w) => {
      const lemma = w.dataset.lemma!;
      const mark = taps[lemma];
      w.classList.toggle("tap-k", mark === "k");
      w.classList.toggle("tap-h", mark === "h");
      // "committed" = already submitted and unchanged since; dimmed so newly
      // added/changed marks stand out as the unsent ones.
      w.classList.toggle("tap-committed", mark !== undefined && submitted[lemma] === mark);
    });
    const total = Object.keys(taps).length;
    root.querySelector("#tapcount")!.textContent = total ? `· ${total} marked` : "";
    opts.onTapsChanged?.(pendingTapCount(epId));
  };
  opts.registerRefresh?.(refreshTapClasses);

  // One delegated listener: gloss-peek beats tap when both match.
  root.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const m = target.closest<HTMLElement>(".m[data-i]");
    if (m) {
      setGloss(m, m.classList.contains("masked"));
      return;
    }
    const w = target.closest<HTMLElement>(".w[data-lemma]");
    if (w) {
      cycleTap(epId, w.dataset.lemma!);
      refreshTapClasses();
    }
  });

  const setGloss = (m: HTMLElement, shown: boolean) => {
    m.classList.toggle("masked", !shown);
    m.textContent = "";
    const g = doc.glossary[Number(m.dataset.i)];
    if (shown) {
      if (g.gloss_segs?.length) m.appendChild(segsNode(g.gloss_segs));
      else m.textContent = g.gloss || "";
    } else m.textContent = "···";
  };

  // -- header stats
  const stats = el("div", "stats");
  (
    [
      ["comprehension", `${Math.round(doc.stats.token_comprehensibility * 100)}%`],
      ["sentences", doc.stats.total_sentences],
      ["i+1", doc.stats.i_plus_1],
      ["reinforcement", doc.stats.reinforcement],
    ] as [string, string | number][]
  ).forEach(([k, v]) => {
    const d = el("span");
    d.append(el("b", "", String(v)), ` ${k}`);
    stats.appendChild(d);
  });
  root.appendChild(stats);

  // -- synopsis
  if (doc.curate?.synopsis) {
    root.appendChild(el("h2", "", "あらすじ"));
    const syn = el("div", "synopsis");
    if (doc.curate.synopsis_segs?.length) syn.appendChild(segsNode(doc.curate.synopsis_segs));
    else syn.textContent = doc.curate.synopsis;
    root.appendChild(syn);
  }

  const readings: Record<string, string> = {};
  doc.glossary.forEach((g) => {
    if (g.reading) readings[g.lemma] = g.reading;
  });
  doc.iplus1.forEach((x) => {
    if (x.reading) readings[x.lemma] = x.reading;
  });

  // -- focal points
  if (doc.curate?.focal_points?.length) {
    root.appendChild(el("h2", "", "Focal points"));
    doc.curate.focal_points.forEach((fp) => {
      const card = el("div", "sent");
      const w = el("span", "w");
      w.dataset.lemma = fp.word;
      w.appendChild(rubyWord(fp.word, readings[fp.word]));
      card.append(w, " — ");
      if (fp.why_segs?.length) card.appendChild(segsNode(fp.why_segs));
      else card.append(fp.why || "");
      root.appendChild(card);
    });
  }

  // -- key vocabulary
  const vocabH = el("h2", "", "Key vocabulary ");
  const tapcount = el("span");
  tapcount.id = "tapcount";
  const revealBtn = el("button", "", "show all definitions") as HTMLButtonElement;
  vocabH.append(tapcount, revealBtn);
  root.appendChild(vocabH);
  root.appendChild(
    el(
      "p",
      "legend",
      "tap the word: ✔ know it → ★ high interest (card priority) → clear · untapped = unknown · tap ··· to peek (mark first, peek after!)",
    ),
  );
  const gl = el("div", "gloss");
  doc.glossary.forEach((g, i) => {
    // word column stays plain — the reading column next to it does that job
    const w = el("span", "w unk", g.lemma);
    w.dataset.lemma = g.lemma;
    const r = el("span", "r", g.reading || "");
    const n = el("span", "n");
    if (g.note_segs?.length) n.appendChild(segsNode(g.note_segs));
    if ((g.recurrence || 0) > 1)
      n.appendChild(el("span", "rec", `${n.childNodes.length ? " " : ""}×${g.recurrence}`));
    const m = el("span", "m");
    if (g.gloss || g.gloss_segs?.length) {
      m.dataset.i = String(i);
      setGloss(m, false);
    }
    gl.append(w, r, n, m);
  });
  root.appendChild(gl);

  let allShown = false;
  revealBtn.addEventListener("click", () => {
    allShown = !allShown;
    root.querySelectorAll<HTMLElement>(".m[data-i]").forEach((m) => setGloss(m, allShown));
    revealBtn.textContent = allShown ? "hide definitions" : "show all definitions";
  });

  // -- i+1 sentences
  root.appendChild(el("h2", "", "i+1 sentences"));
  doc.iplus1.forEach((x) => {
    const s = doc.sentences_by_idx[x.sentence_idx];
    if (s) root.appendChild(sentenceCard(s, x.lemma, opts.onSeek));
  });

  // -- reinforcement
  if (doc.reinforcement.length) {
    root.appendChild(el("h2", "", "Reinforcement"));
    doc.reinforcement.forEach((idx) => {
      const s = doc.sentences_by_idx[idx];
      if (s) root.appendChild(sentenceCard(s, null, opts.onSeek));
    });
  }

  refreshTapClasses();
  return root;
}
