// Page reader (#/page/<id>): a 5ch thread rendered as readable posts with
// the same tap-a-word machinery as the player — every token is a tap target
// (tokenSpan anyWord), taps open the shared gloss popup, marks cycle through
// the shared tap store and sync live as normal tap batches. Reading is offline-
// first: the bundle (posts + tokenized sentences + definitions) downloads on
// first open and reads from disk after. "✓ finished" is the page's
// mark-watched — exposures activate, no cards ever — after which the row can
// be swiped away on the Pages tab.

import { createGlossPopup } from "../gloss-popup";
import {
  applyPaintKnown,
  fetchPaint,
  getCachedPaint,
  listClass,
  listsFor,
  NO_LISTS,
  paintsInterest,
  sameLists,
} from "../paint";
import type { ListSnapshot, PaintLists } from "../paint";
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
  getOutbox,
  getSubmitted,
  getTaps,
  pendingTapCount,
  pendingWatched,
  queueWatched,
  submitTaps,
} from "../store";
import { flushOutbox } from "../sync";
import { cancelTapSync, onTapSync, scheduleTapSync } from "../livesync";
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

  // --- toolbar: furigana · highlight · mark-sync state · finished ----------
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
  // marks sync on their own (livesync.ts); this only says where they stand
  const syncEl = el("span", "small muted sync-state");
  const doneBtn = el("button", "small", "✓ finished") as HTMLButtonElement;
  const backLink = el("a", "small btn", "‹ pages") as HTMLAnchorElement;
  backLink.href = "#/pages";
  toolbar.append(backLink, rubyBtn, hlBtn, syncEl, doneBtn);

  const posts = el("div", "posts");
  const moreBtn = el("button", "small more", "… more posts") as HTMLButtonElement;
  moreBtn.style.display = "none";
  root.append(titleEl, toolbar, status, posts, moreBtn);

  let doc: PageDoc | null = null;
  let sentences: TranscriptSentence[] = [];
  // the ledger's global lists for this thread (blue think-you-know, purple
  // ★ interest, green should-know), live state over the bundle's snapshot —
  // standing state, so they paint like the unknown wash
  let lists: PaintLists = NO_LISTS;
  let snapshot: ListSnapshot = {}; // the bundle's copy of the lists
  let defs: Definitions = {};
  let rendered = 0; // posts painted so far

  const popup = createGlossPopup({
    episodeId,
    defs: () => defs,
    interest: () => lists.interest,
    onMarkChanged: () => {
      paintTaps();
      scheduleTapSync(episodeId);
      syncState();
    },
    extraClass: "fixed",
  });
  root.appendChild(popup.el);

  const paintTaps = () => {
    const taps = getTaps(episodeId);
    const submitted = getSubmitted(episodeId);
    // marks moved → the lists moved (a ★ takes a word green → purple)
    lists = listsFor(getCachedPaint(episodeId), snapshot);
    posts.querySelectorAll<HTMLElement>(".w[data-lemma]").forEach((w) => {
      const lemma = w.dataset.lemma!;
      const mark = taps[lemma];
      const lc = listClass(lemma, lists);
      w.classList.toggle("hl-know", lc === "hl-know");
      w.classList.toggle("hl-int", lc === "hl-int");
      w.classList.toggle("hl-sk", lc === "hl-sk");
      w.classList.toggle("tap-k", mark === "k");
      w.classList.toggle("tap-h", paintsInterest(mark, lemma, lists.interest));
      w.classList.toggle("tap-u", mark === "u");
      w.classList.toggle("tap-committed", mark !== undefined && submitted[w.dataset.lemma!] === mark);
    });
  };

  /** Pull the ledger's lists as of now and repaint if anything moved. */
  const livePaint = () =>
    fetchPaint(episodeId).then((fresh) => {
      if (!fresh || !root.isConnected) return;
      const moved = applyPaintKnown(sentences, fresh);
      const next = listsFor(fresh, snapshot);
      const same = sameLists(next, lists);
      lists = next;
      if (moved || !same) repaintPosts();
    });

  const syncState = () => {
    const n = pendingTapCount(episodeId);
    const queued = getOutbox().some(
      (a) => a.kind === "taps" && a.batch.episode_id === episodeId,
    );
    syncEl.textContent = n ? `⇪ ${n}…` : queued ? "⇪ queued" : "";
    syncEl.title = n
      ? `${n} mark${n > 1 ? "s" : ""} syncing`
      : queued
        ? "marks queued — will sync when reachable"
        : "";
  };
  onTapSync((ep, result) => {
    if (ep !== episodeId || !root.isConnected) return;
    paintTaps();
    syncState();
    // the ledger re-judged on arrival: a ✗ may have dropped a word onto the
    // blue / green list — pull the lists so it paints in this sitting
    if (result?.sent) void livePaint();
  });

  const syncDone = () => {
    const done = !!pendingWatched(episodeId);
    doneBtn.textContent = done ? "✓ read (syncing)" : "✓ finished";
    doneBtn.disabled = done;
  };

  doneBtn.addEventListener("click", () => {
    const n = pendingTapCount(episodeId);
    if (
      !confirm(
        "Finished reading? Word exposures land in the ledger; no Anki cards are made." +
          (n ? `\n\n${n} unsynced mark(s) will be sent first.` : ""),
      )
    )
      return;
    cancelTapSync(episodeId);
    if (n) submitTaps(episodeId); // FIFO: taps flush before the watched
    queueWatched(episodeId, false); // pages never mint cards
    syncDone();
    void flushOutbox().then(() => {
      paintTaps();
      syncState();
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
            const lc = listClass(t.l, lists);
            if (lc) n.classList.add(lc);
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
      applyPaintKnown(sentences, paint);
      snapshot = transcript ?? {};
      lists = listsFor(paint, snapshot);
      defs = (await loadLocalPageDefinitions(episodeId)) ?? {};
      if (!doc || !sentences.length) throw new Error("page bundle incomplete — re-download");
      titleEl.textContent = doc.title;
      status.textContent = `${doc.post_count} posts`;
      fill();
      syncState();
      syncDone();
      // marks made before this reopen and never sent (app killed mid-debounce)
      if (pendingTapCount(episodeId)) scheduleTapSync(episodeId);
      void livePaint();
      // the /immerse page pass may have enriched the dictionary since the
      // bundle was pulled — refresh quietly and swap the defs in
      if (!rec.curated) {
        void refreshPageSidecars(episodeId).then(async (fresh) => {
          if (!fresh || !root.isConnected) return;
          sentences = fresh.sentences;
          const st = getCachedPaint(episodeId);
          applyPaintKnown(sentences, st);
          snapshot = fresh;
          lists = listsFor(st, snapshot);
          defs = (await loadLocalPageDefinitions(episodeId)) ?? defs;
        });
      }
    } catch (e) {
      status.textContent = `⚠ ${(e as Error).message}`;
    }
  })();

  return root;
}
