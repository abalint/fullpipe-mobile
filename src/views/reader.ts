// Page reader (#/page/<id>): a 5ch thread rendered as readable posts with
// the same tap-a-word machinery as the player — every token is a tap target
// (tokenSpan anyWord), taps open the shared gloss popup, marks cycle through
// the shared tap store and submit as a normal tap batch. Reading is offline-
// first: the bundle (posts + tokenized sentences + definitions) downloads on
// first open and reads from disk after. "✓ finished" is the page's
// mark-watched — exposures activate, no cards ever — after which the row can
// be swiped away on the Pages tab.

import { createGlossPopup } from "../gloss-popup";
import { NO_CONFIRM } from "../lists";
import { applyKnown, confirmFrom, fetchPaint, getCachedPaint, knownFor } from "../paint";
import { tokenSpan } from "../prep-render";
import {
  downloadPage,
  getPageRecord,
  loadLocalPage,
  loadLocalPageDefinitions,
  loadLocalPageTranscript,
  refreshPageSidecars,
} from "../pages";
import {
  getSubmitted,
  getTaps,
  pendingTapCount,
  pendingWatched,
  queueWatched,
  submitTaps,
} from "../store";
import { flushOutbox } from "../sync";
import type { Definitions, PageDoc, PagePost, TranscriptSentence } from "../types";

const CHUNK = 40; // posts rendered per fill — a 1000-post thread must not DOM-bomb

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function readerView(episodeId: string): HTMLElement {
  const root = el("div", "view reader-view");
  const titleEl = el("h1", "", getPageRecord(episodeId)?.title ?? "");
  const status = el("div", "status");

  // --- toolbar: furigana · highlight · submit marks · finished -------------
  // Both display toggles are global reading preferences (persisted), not
  // per-thread. The popup always shows furigana regardless of あ — scoped in
  // style.css — because looking a word up is asking for its reading.
  const RUBY_KEY = "fp.reader.ruby"; // "off" = furigana hidden in the article
  const HL_KEY = "fp.reader.hl"; // "off" = unknown-word + think-you-know wash hidden
  const toolbar = el("div", "reader-toolbar");
  const rubyBtn = el("button", "small", "あ") as HTMLButtonElement;
  const syncRuby = () => {
    const off = localStorage.getItem(RUBY_KEY) === "off";
    root.classList.toggle("no-ruby", off);
    rubyBtn.classList.toggle("on", !off);
  };
  rubyBtn.addEventListener("click", () => {
    localStorage.setItem(RUBY_KEY, root.classList.contains("no-ruby") ? "on" : "off");
    syncRuby();
  });
  const hlBtn = el("button", "small", "◨ hl") as HTMLButtonElement;
  const syncHl = () => {
    const off = localStorage.getItem(HL_KEY) === "off";
    root.classList.toggle("no-hl", off);
    hlBtn.classList.toggle("on", !off);
  };
  hlBtn.addEventListener("click", () => {
    localStorage.setItem(HL_KEY, root.classList.contains("no-hl") ? "on" : "off");
    syncHl();
  });
  syncRuby();
  syncHl();
  const submitBtn = el("button", "small", "⇪ submit marks") as HTMLButtonElement;
  const doneBtn = el("button", "small", "✓ finished") as HTMLButtonElement;
  const backLink = el("a", "small btn", "‹ pages") as HTMLAnchorElement;
  backLink.href = "#/pages";
  toolbar.append(backLink, rubyBtn, hlBtn, submitBtn, doneBtn);

  const posts = el("div", "posts");
  const moreBtn = el("button", "small more", "… more posts") as HTMLButtonElement;
  moreBtn.style.display = "none";
  root.append(titleEl, toolbar, status, posts, moreBtn);

  let doc: PageDoc | null = null;
  let sentences: TranscriptSentence[] = [];
  // the ledger's think-you-know queue for this thread (blue), from the
  // transcript bundle — standing state, so it paints like the unknown wash
  let thinkKnown: ReadonlySet<string> = NO_CONFIRM;
  let defs: Definitions = {};
  let rendered = 0; // posts painted so far

  const popup = createGlossPopup({
    episodeId,
    defs: () => defs,
    onMarkChanged: () => {
      paintTaps();
      syncSubmit();
    },
    extraClass: "fixed",
  });
  root.appendChild(popup.el);

  const paintTaps = () => {
    const taps = getTaps(episodeId);
    const submitted = getSubmitted(episodeId);
    posts.querySelectorAll<HTMLElement>(".w[data-lemma]").forEach((w) => {
      const mark = taps[w.dataset.lemma!];
      w.classList.toggle("tap-k", mark === "k");
      w.classList.toggle("tap-h", mark === "h");
      w.classList.toggle("tap-committed", mark !== undefined && submitted[w.dataset.lemma!] === mark);
    });
  };

  const syncSubmit = () => {
    const n = pendingTapCount(episodeId);
    submitBtn.textContent = n ? `⇪ submit marks (${n})` : "⇪ submit marks";
    submitBtn.disabled = !n;
  };

  const syncDone = () => {
    const done = !!pendingWatched(episodeId);
    doneBtn.textContent = done ? "✓ read (syncing)" : "✓ finished";
    doneBtn.disabled = done;
  };

  submitBtn.addEventListener("click", () => {
    submitBtn.disabled = true;
    submitTaps(episodeId);
    void flushOutbox().then(() => {
      paintTaps();
      syncSubmit();
    });
  });

  doneBtn.addEventListener("click", () => {
    const n = pendingTapCount(episodeId);
    if (
      !confirm(
        "Finished reading? Word exposures land in the ledger; no Anki cards are made." +
          (n ? `\n\n${n} unsubmitted mark(s) will be submitted first.` : ""),
      )
    )
      return;
    if (n) submitTaps(episodeId); // FIFO: taps flush before the watched
    queueWatched(episodeId, false); // pages never mint cards
    syncDone();
    void flushOutbox().then(() => {
      paintTaps();
      syncSubmit();
      syncDone();
    });
  });

  // --- post rendering ------------------------------------------------------
  const postNode = (p: PagePost): HTMLElement => {
    const card = el("div", "post");
    card.id = `p${p.n}`;
    const head = el("div", "post-head");
    head.append(el("span", "post-n", String(p.n)), el("span", "post-name", p.name));
    head.appendChild(el("span", "post-meta", `${p.date} · ID:${p.uid}`));
    for (const n of p.replies_to) {
      const jump = el("button", "post-reply", `≫${n}`) as HTMLButtonElement;
      jump.addEventListener("click", () => jumpToPost(n));
      head.appendChild(jump);
    }
    card.appendChild(head);
    const body = el("div", "post-body");
    for (const line of p.lines) {
      const ln = el("div", `post-line${line.length ? "" : " blank"}`);
      for (const si of line) {
        const s = sentences[si];
        if (!s) continue;
        s.tokens.forEach((t, ti) => {
          const n = tokenSpan(t, null, true); // any word answers a tap
          if (n instanceof HTMLElement) {
            n.dataset.si = String(si);
            n.dataset.ti = String(ti);
            if (t.l && thinkKnown.has(t.l)) n.classList.add("hl-know");
          }
          ln.appendChild(n);
        });
      }
      body.appendChild(ln);
    }
    card.appendChild(body);
    return card;
  };

  const fill = (upTo?: number) => {
    if (!doc) return;
    const target =
      upTo != null
        ? Math.max(rendered + CHUNK, doc.posts.findIndex((p) => p.n === upTo) + 1)
        : rendered + CHUNK;
    while (rendered < Math.min(target, doc.posts.length))
      posts.appendChild(postNode(doc.posts[rendered++]));
    moreBtn.style.display = rendered < doc.posts.length ? "" : "none";
    moreBtn.textContent = `… more posts (${doc.posts.length - rendered} left)`;
    paintTaps();
  };
  moreBtn.addEventListener("click", () => fill());

  /** Rebuild the posts already on screen (paint state moved under them). */
  const repaintPosts = () => {
    if (!doc) return;
    const n = rendered;
    posts.textContent = "";
    rendered = 0;
    while (rendered < n) posts.appendChild(postNode(doc.posts[rendered++]));
    paintTaps();
  };

  // auto-fill as the sentinel scrolls into view (button stays as fallback)
  if (typeof IntersectionObserver !== "undefined") {
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && moreBtn.style.display !== "none") fill();
    }).observe(moreBtn);
  }

  const jumpToPost = (n: number) => {
    if (!document.getElementById(`p${n}`)) fill(n);
    const target = document.getElementById(`p${n}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
  };

  // tap a word → the shared popup; tap anywhere else → dismiss it
  posts.addEventListener("click", (e) => {
    const w = (e.target as HTMLElement).closest<HTMLElement>(".w[data-lemma]");
    if (!w) return;
    e.stopPropagation();
    const si = w.dataset.si != null ? Number(w.dataset.si) : undefined;
    popup.show(
      w.dataset.lemma!,
      w.dataset.ti != null ? Number(w.dataset.ti) : undefined,
      si != null ? sentences[si] : undefined,
    );
  });
  root.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".w") || (e.target as HTMLElement).closest("button"))
      return;
    popup.hide();
  });

  // --- load: local bundle first, download on first open --------------------
  void (async () => {
    try {
      let rec = getPageRecord(episodeId);
      if (!rec) {
        status.textContent = "downloading page…";
        rec = await downloadPage(episodeId);
      }
      doc = await loadLocalPage(episodeId);
      const transcript = await loadLocalPageTranscript(episodeId);
      sentences = transcript?.sentences ?? [];
      // live paint state (paint.ts) over the cached bundle: words known
      // since, the current think-you-know list; cached copy first
      const paint = getCachedPaint(episodeId);
      applyKnown(sentences, knownFor(paint));
      thinkKnown = confirmFrom(paint, transcript);
      defs = (await loadLocalPageDefinitions(episodeId)) ?? {};
      if (!doc || !sentences.length) throw new Error("page bundle incomplete — re-download");
      titleEl.textContent = doc.title;
      status.textContent = `${doc.post_count} posts`;
      fill();
      syncSubmit();
      syncDone();
      void fetchPaint(episodeId).then((fresh) => {
        if (!fresh || !root.isConnected) return;
        const moved = applyKnown(sentences, knownFor(fresh));
        const list = new Set(fresh.confirm);
        const same = list.size === thinkKnown.size && [...list].every((l) => thinkKnown.has(l));
        thinkKnown = list;
        if (moved || !same) repaintPosts();
      });
      // the /immerse page pass may have enriched the dictionary since the
      // bundle was pulled — refresh quietly and swap the defs in
      if (!rec.curated) {
        void refreshPageSidecars(episodeId).then(async (fresh) => {
          if (!fresh || !root.isConnected) return;
          sentences = fresh.sentences;
          const st = getCachedPaint(episodeId);
          applyKnown(sentences, knownFor(st));
          thinkKnown = confirmFrom(st, fresh);
          defs = (await loadLocalPageDefinitions(episodeId)) ?? defs;
        });
      }
    } catch (e) {
      status.textContent = `⚠ ${(e as Error).message}`;
    }
  })();

  return root;
}
