// The other two global word lists, reviewed the way the confirm queue is
// (LIVE_REVIEW.md §1): the ★ high-interest set ("I want to learn this") and
// the should-know window (the most frequent words in native media you don't
// know yet). Same card as Confirm, different verbs — ✓ marks a word known
// (it leaves every list); ★ on a should-know word moves it to the ★ list.
// Server-backed; needs a connection.

import { api, ApiError } from "../api";
import { reviewCard } from "./confirm";
import type { ListName, ListWord } from "../types";

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const COPY: Record<ListName, { title: string; blurb: string; empty: string }> = {
  interest: {
    title: "★ Want to learn",
    blurb: "Words you starred while watching. They stay here — and paint purple " +
      "in every episode — until you meet them enough to move to Confirm, or " +
      "you mark one known.",
    empty: "Nothing starred yet — ★ a word in the player and it lands here.",
  },
  should_know: {
    title: "Should know",
    blurb: "The most common words in native media you don't know yet, most " +
      "frequent first. They paint green while you watch. ✓ if you already " +
      "know one, ★ to pull it onto your want-to-learn list.",
    empty: "You know every word in the window — nothing to show.",
  },
};

function wordCard(name: ListName, w: ListWord, onDone: () => void): HTMLElement {
  const actions = [
    { label: "✓ I know it", primary: true,
      run: async () => { await api.markListWord(w.lemma, "k"); } },
  ];
  if (name === "should_know")
    actions.push({ label: "★ Want to learn", primary: false,
      run: async () => { await api.markListWord(w.lemma, "h"); } });
  return reviewCard(w, actions, onDone);
}

export function wordListView(name: ListName): HTMLElement {
  const copy = COPY[name];
  const root = el("div", `view list-${name}`);
  root.appendChild(el("h1", "", copy.title));
  root.appendChild(el("div", "muted", copy.blurb));
  const status = el("div", "status", "loading…");
  const list = el("div");
  root.append(status, list);

  let remaining = 0;
  const count = () => {
    status.textContent = remaining
      ? `${remaining} word${remaining > 1 ? "s" : ""}`
      : copy.empty;
  };

  void (async () => {
    try {
      const { words } = await api.getWordList(name);
      remaining = words.length;
      count();
      for (const w of words) {
        const card = wordCard(name, w, () => {
          card.remove();
          remaining--;
          count();
        });
        list.appendChild(card);
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      status.textContent = `⚠ needs the server — ${msg}`;
    }
  })();

  return root;
}
