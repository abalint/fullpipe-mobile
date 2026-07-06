// Prep screen: cache-first prep doc + tap capture + submit-to-outbox.
// Submitting freezes taps into an idempotent batch, tries an immediate flush,
// and marks the episode watched server-side via the /taps semantics.

import { api } from "../api";
import { renderPrep } from "../prep-render";
import {
  cachePrep,
  clearSubmitted,
  clearTaps,
  deleteCachedPrep,
  getCachedPrep,
  getSubmitted,
  getTaps,
  pendingTapCount,
  submitTaps,
} from "../store";
import { deleteVideo, getVideoRecord, playVideo } from "../video";
import { flushOutbox } from "../sync";
import { ratingBlock } from "./queue";
import type { PrepDoc } from "../types";

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function prepView(episodeId: string): HTMLElement {
  const root = el("div", "view");
  const status = el("div", "status");
  root.appendChild(status);

  async function load(): Promise<void> {
    const cached: PrepDoc | null = getCachedPrep(episodeId);
    if (cached) {
      status.textContent = "";
      show(cached);
    }
    try {
      const fresh = await api.getPrep(episodeId);
      cachePrep(fresh);
      status.textContent = "";
      // re-render even over a cached doc: server-side curation/fixes should
      // show up on reopen, not only after a cache clear (taps live in the
      // store, so a rebuild loses nothing)
      if (JSON.stringify(fresh) !== JSON.stringify(cached)) show(fresh);
    } catch (e) {
      if (!cached)
        status.textContent = `⚠ not cached and server unreachable — ${(e as Error).message}`;
    }
  }

  function show(doc: PrepDoc): void {
    root.querySelector(".prep")?.remove();
    root.querySelector(".submit-bar")?.remove();

    const title = el("h1", "", doc.episode.title || doc.episode.id);
    const bar = el("div", "submit-bar");
    const submit = el("button", "primary", "Submit feedback") as HTMLButtonElement;
    const watchedBtn = el("button", "", "Mark watched") as HTMLButtonElement;
    const noCardsBtn = el("button", "", "Watched · no cards") as HTMLButtonElement;
    const copyBtn = el("button", "", "Copy blob") as HTMLButtonElement;
    const barStatus = el("span", "muted");
    if (getVideoRecord(episodeId)) {
      const play = el("button", "", "▶ VLC") as HTMLButtonElement;
      play.addEventListener("click", () => {
        void playVideo(episodeId, doc.episode.title).catch(
          (e) => (barStatus.textContent = `⚠ ${(e as Error).message}`),
        );
      });
      bar.append(play);
    }
    bar.append(submit, watchedBtn, noCardsBtn, copyBtn, barStatus);

    // Rating is available the whole time, not just after Mark watched — rate
    // a dud early, then either "Watched · no cards" (exposures still count)
    // or swipe-delete from the queue (the ledger keeps the rating either way).
    // Rating + tags as one control. Engaging it (any star/tag tap) sets
    // `engaged`, which both guards the server prefill from clobbering an
    // in-progress rating and cancels the post-watch auto-return so there's time
    // to pick tags.
    let engaged = false;
    const stars = el("span");
    const mountRating = (rating: number | null, tags: string[]) => {
      stars.textContent = "";
      stars.appendChild(
        ratingBlock(
          episodeId,
          rating,
          tags,
          (e) => (barStatus.textContent = `⚠ ${e.message}`),
          () => (engaged = true),
        ),
      );
    };
    mountRating(null, []);
    // prefill from the server if it already has a rating (offline: stays blank)
    void api
      .getJob(episodeId)
      .then((j) => {
        if (!engaged) mountRating(j.rating ?? null, j.tags ?? []);
      })
      .catch(() => {});
    bar.insertBefore(stars, barStatus);

    const updateSubmit = (pending: number) => {
      submit.textContent = pending ? `Submit feedback (${pending})` : "Submit feedback";
    };

    // renderPrep hands us its tap-repaint fn; we call it after a submit to
    // re-style the marks as committed without rebuilding the whole doc.
    let refreshTaps = () => {};
    const body = renderPrep(doc, {
      onTapsChanged: updateSubmit,
      registerRefresh: (fn) => (refreshTaps = fn),
    });
    body.insertBefore(title, body.firstChild);
    root.append(body, bar);
    updateSubmit(pendingTapCount(episodeId));

    // Remind you that this episode's feedback is already in — the marks below
    // are what you sent, not a fresh slate.
    const submittedCount = Object.keys(getSubmitted(episodeId)).length;
    if (submittedCount && !pendingTapCount(episodeId))
      barStatus.textContent = `feedback submitted ✔ · ${submittedCount} marked`;

    // Step 1: feedback — known-taps hit the ledger, high-interest steers card
    // selection. Cards are NOT pushed yet; that happens at Mark watched.
    submit.addEventListener("click", async () => {
      submit.disabled = true;
      submitTaps(episodeId); // empty batch = "no corrections, default selection"
      const res = await flushOutbox();
      barStatus.textContent = res.remaining
        ? `queued (outbox: ${res.remaining} pending — will sync when reachable)`
        : "feedback synced ✔ — watch, then Mark watched";
      // Keep the marks visible (now baseline-styled as committed) instead of
      // wiping them; the button falls to 0 because nothing is unsent anymore.
      refreshTaps();
      submit.disabled = false;
    });

    // Step 2: after actually watching — activates exposures and cleans this
    // episode off the phone. "Mark watched" also pushes the selected cards to
    // Anki; "Watched · no cards" is the disliked-it branch: same close-out,
    // deck untouched (rate it so the dislike is on record).
    const finishWatched = async (pushCards: boolean) => {
      watchedBtn.disabled = true;
      noCardsBtn.disabled = true;
      try {
        const res = await api.markWatched(episodeId, pushCards);
        const c = res.cards;
        if (c?.error) {
          barStatus.textContent = `watched ✔ but cards failed: ${c.error} — tap again to retry`;
          watchedBtn.disabled = false;
          noCardsBtn.disabled = false;
          return;
        }
        barStatus.textContent = pushCards
          ? `watched ✔ · ${c?.pushed ?? 0} cards → ${c?.deck ?? "Anki"} · rate it?`
          : "watched ✔ · no cards pushed · rate it?";
        deleteCachedPrep(episodeId); // phone-side cleanup: prep + video + marks
        clearTaps(episodeId);
        clearSubmitted(episodeId);
        await deleteVideo(episodeId);
        // rate + tag while the impression is fresh; touching the rating cancels
        // the auto-return so there's time to pick tags (else the queue row keeps
        // the control). Reset here so only a *post-watch* touch counts.
        engaged = false;
        setTimeout(() => {
          if (!engaged) location.hash = "#/queue";
        }, 12000);
      } catch (e) {
        barStatus.textContent = `⚠ ${(e as Error).message}`;
        watchedBtn.disabled = false;
        noCardsBtn.disabled = false;
      }
    };
    watchedBtn.addEventListener("click", () => void finishWatched(true));
    noCardsBtn.addEventListener("click", () => void finishWatched(false));

    // P9 offline fallback: the copy-paste corrections blob still works.
    copyBtn.addEventListener("click", async () => {
      const taps = Object.entries(getTaps(episodeId));
      const blob = JSON.stringify({
        episode_id: episodeId,
        batch_id: Array.from(crypto.getRandomValues(new Uint8Array(8)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
        taps,
      });
      try {
        await navigator.clipboard.writeText(blob);
        barStatus.textContent = "blob copied ✔";
      } catch {
        prompt("copy manually:", blob);
      }
    });
  }

  void load();
  return root;
}
