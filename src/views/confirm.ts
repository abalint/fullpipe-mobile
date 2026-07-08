// Confirm-words queue: the human checkpoint that replaced silent exposure→known
// promotion. The ledger surfaces words whose watched exposures cleared the
// frequency-scaled bar; you answer "I know it" (→ known) or "Not yet" (→ stays
// learning, snoozed until more exposures). Server-backed; needs a connection.

import { api, ApiError } from "../api";
import { rubyWord, segsNode } from "../prep-render";
import type { ConfirmCandidate, DictEntry } from "../types";

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** First few JMdict glosses for the word, if the server had a dictionary. */
function glossText(senses?: DictEntry[]): string {
  const gs = (senses ?? []).flatMap((e) => e.s.flatMap((s) => s.g));
  return [...new Set(gs)].slice(0, 4).join("; ");
}

function candidateCard(c: ConfirmCandidate, onDone: (known: boolean) => void): HTMLElement {
  const card = el("div", "confirm-card");

  const head = el("div", "cc-head");
  const word = el("span", "cc-word");
  // furigana over the kanji only — reading_segs is pre-split on the PC; fall
  // back to whole-word ruby for old servers that don't send it
  if (c.reading_segs?.length) word.appendChild(segsNode(c.reading_segs));
  else word.appendChild(rubyWord(c.lemma, c.reading));
  head.appendChild(word);
  const seen = c.episode_spread === 1 ? "1 episode" : `${c.episode_spread} episodes`;
  head.appendChild(el("span", "cc-seen", `seen in ${seen}`));
  card.appendChild(head);

  const gloss = glossText(c.senses);
  if (gloss) card.appendChild(el("div", "cc-gloss", gloss));
  if (c.episodes?.length)
    card.appendChild(el("div", "cc-eps", c.episodes.slice(0, 3).join(" · ")));

  const actions = el("div", "cc-actions");
  const yes = el("button", "primary small", "✓ I know it") as HTMLButtonElement;
  const no = el("button", "small", "Not yet") as HTMLButtonElement;
  const answer = async (known: boolean) => {
    yes.disabled = no.disabled = true;
    try {
      await api.confirmWord(c.lemma, known);
      onDone(known);
    } catch (e) {
      yes.disabled = no.disabled = false;
      alert((e as Error).message);
    }
  };
  yes.addEventListener("click", () => void answer(true));
  no.addEventListener("click", () => void answer(false));
  actions.append(yes, no);
  card.appendChild(actions);
  return card;
}

export function confirmView(): HTMLElement {
  const root = el("div", "view");
  root.appendChild(el("h1", "", "Confirm words"));
  root.appendChild(el(
    "div", "muted",
    "You've met these enough while watching that we think you know them. " +
    "Confirm the ones you do — that's what counts them as known. " +
    "“Not yet” keeps a word in learning and stops asking until you see it more.",
  ));
  const status = el("div", "status", "loading…");
  const list = el("div");
  root.append(status, list);

  let remaining = 0;
  const done = (card: HTMLElement, known: boolean) => {
    card.remove();
    remaining--;
    status.textContent = remaining
      ? `${remaining} left`
      : "All caught up — nothing to confirm.";
  };

  void (async () => {
    try {
      const { candidates } = await api.getConfirmQueue();
      remaining = candidates.length;
      status.textContent = remaining
        ? `${remaining} word${remaining > 1 ? "s" : ""} to confirm`
        : "All caught up — nothing to confirm.";
      for (const c of candidates) {
        const card = candidateCard(c, (known) => done(card, known));
        list.appendChild(card);
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      status.textContent = `⚠ needs the server — ${msg}`;
    }
  })();

  return root;
}
