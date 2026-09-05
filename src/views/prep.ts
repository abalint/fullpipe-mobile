// Prep screen: cache-first prep doc + tap capture with live sync. Every
// ✓ / ★ freezes (debounced, livesync.ts) into an idempotent outbox batch and
// flushes on its own — there is no submit step; the bar only reports sync
// state. Mark-watched goes the same way when the server is unreachable — the
// close-out happens locally now, the server catches up at the next sync.

import { api, ApiError } from "../api";
import { applyPaintKnown, fetchPaint, getCachedPaint, listsFor } from "../paint";
import { renderPrep } from "../prep-render";
import {
  cachePrep,
  clearSubmitted,
  clearTaps,
  deleteCachedPrep,
  getCachedJobs,
  getCachedPrep,
  getOutbox,
  getSubmitted,
  getTaps,
  pendingTapCount,
  queuePassive,
  queueWatched,
} from "../store";
import { cancelTapSync, onTapSync, scheduleTapSync, syncTapsNow } from "../livesync";
import { ratingBlock } from "./queue";
import type { FollowState, PrepDoc } from "../types";

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

  let current: PrepDoc | null = null;
  // the rendered doc's mark/list repaint (renderPrep hands it over) — called
  // when live paint state lands so the global lists colour in without a
  // rebuild
  let repaintMarks: () => void = () => {};

  async function load(): Promise<void> {
    const cached: PrepDoc | null = getCachedPrep(episodeId);
    const cachedRaw = cached ? JSON.stringify(cached) : null; // before show() overlays paint
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
      if (JSON.stringify(fresh) !== cachedRaw) show(fresh);
    } catch (e) {
      if (!cached)
        status.textContent = `⚠ not cached and server unreachable — ${(e as Error).message}`;
    }
    // live paint state (paint.ts): words the ledger now calls known lose
    // their unknown wash — the doc's token flags froze at coverage time —
    // and the global lists (blue / purple / green) take their current shape
    await livePaint();
  }

  async function livePaint(): Promise<void> {
    const st = await fetchPaint(episodeId);
    if (!st || !current || !root.isConnected) return;
    if (applyPaintKnown(Object.values(current.sentences_by_idx), st)) show(current);
    else repaintMarks();
  }

  function show(doc: PrepDoc): void {
    current = doc;
    applyPaintKnown(Object.values(doc.sentences_by_idx), getCachedPaint(episodeId));
    root.querySelector(".prep")?.remove();
    root.querySelector(".submit-bar")?.remove();

    const title = el("h1", "", doc.episode.title || doc.episode.id);
    const bar = el("div", "submit-bar");
    const watchedBtn = el("button", "", "✓ Mark watched") as HTMLButtonElement;
    watchedBtn.title = "Mark watched — pushes the selected cards to Anki";
    const listenBtn = el("button", "", "🎧 + listen") as HTMLButtonElement;
    listenBtn.title = "Mark watched + keep on the Listen tab for passive audio";
    const noCardsBtn = el("button", "", "No cards") as HTMLButtonElement;
    noCardsBtn.title = "Mark watched without pushing cards (disliked it)";
    const barStatus = el("div", "muted bar-status");
    // marks' sync state — its own line, so a sync landing never overwrites a
    // "watched ✔ … rate it?" message and vice versa
    const tapStatus = el("div", "muted bar-status tap-status");
    const watch = el("a", "btn primary", "▶ Watch") as HTMLAnchorElement;
    watch.href = `#/player/${encodeURIComponent(episodeId)}`;

    // Row 1 — pre-watch: play. (Feedback used to be a button here; marks now
    // sync live as you make them — see tapStatus.)
    const actionRow = el("div", "bar-row");
    actionRow.append(watch);

    // Row 2 — the close-out trio; the caption carries the shared "this marks
    // it watched" semantics so the labels can stay short and equal-width.
    const closeRow = el("div", "bar-row");
    closeRow.append(watchedBtn, listenBtn, noCardsBtn);
    bar.append(actionRow, el("div", "bar-caption", "after watching"), closeRow);

    // Rating is available the whole time, not just after Mark watched — rate
    // a dud early, then either "Watched · no cards" (exposures still count)
    // or swipe-delete from the queue (the ledger keeps the rating either way).
    // Rating + tags as one control. Engaging it (any star/tag tap) sets
    // `engaged`, which both guards the server prefill from clobbering an
    // in-progress rating and cancels the post-watch auto-return so there's time
    // to pick tags.
    let engaged = false;
    const stars = el("span");
    const mountRating = (
      rating: number | null,
      tags: string[],
      axes: Record<string, number> = {},
      follow: FollowState | null = null,
    ) => {
      stars.textContent = "";
      stars.appendChild(
        ratingBlock(
          episodeId,
          rating,
          tags,
          () => (engaged = true),
          () => (barStatus.textContent = "rating queued — will sync when reachable"),
          axes,
          follow,
        ),
      );
    };
    // prefill from the queue snapshot (works offline), then the live server
    const snap = getCachedJobs()?.jobs.find((j) => j.episode_id === episodeId);
    mountRating(snap?.rating ?? null, snap?.tags ?? [], snap?.axes ?? {}, snap?.follow ?? null);
    void api
      .getJob(episodeId)
      .then((j) => {
        if (!engaged) mountRating(j.rating ?? null, j.tags ?? [], j.axes ?? {}, j.follow ?? null);
      })
      .catch(() => {});

    // Row 3 — rating + tags.
    const metaRow = el("div", "bar-meta");
    metaRow.append(stars);
    bar.append(metaRow, tapStatus, barStatus);

    // Where the marks stand against the server: debouncing → in the outbox
    // (offline) → synced. Empty when nothing has been marked.
    const syncStatus = () => {
      const pending = pendingTapCount(episodeId);
      const queued = getOutbox().some(
        (a) => a.kind === "taps" && a.batch.episode_id === episodeId,
      );
      const marked = Object.keys(getTaps(episodeId)).length;
      tapStatus.textContent = pending
        ? `${pending} mark${pending > 1 ? "s" : ""} · syncing…`
        : queued
          ? `${marked} marked · queued — will sync when reachable`
          : marked || Object.keys(getSubmitted(episodeId)).length
            ? `${marked} marked · synced ✔`
            : "";
    };

    // renderPrep hands us its tap-repaint fn; we call it after a sync lands
    // to re-style the marks as committed without rebuilding the whole doc.
    let refreshTaps = () => {};
    const body = renderPrep(doc, {
      onTapsChanged: (pending) => {
        if (pending) scheduleTapSync(episodeId);
        syncStatus();
      },
      registerRefresh: (fn) => (refreshTaps = repaintMarks = fn),
      lists: () => listsFor(getCachedPaint(episodeId), null),
      // sentence timestamps jump into the in-app player at that moment
      onSeek: (sec) =>
        (location.hash = `#/player/${encodeURIComponent(episodeId)}/${Math.floor(sec)}`),
    });
    body.insertBefore(title, body.firstChild);
    root.append(body, bar);
    syncStatus();
    // marks made here before the doc reopened (or in the player) and still
    // waiting on their debounce/flush: send them
    if (pendingTapCount(episodeId)) scheduleTapSync(episodeId);
    // a sync landed (from this screen or the player): restyle the marks as
    // committed and update the line
    onTapSync((ep, result) => {
      if (ep !== episodeId || !root.isConnected) return;
      refreshTaps();
      syncStatus();
      // the ledger re-judged on arrival — pull the lists so a ✗ that
      // dropped a word onto blue / green paints now
      if (result?.sent) void livePaint();
    });

    // Step 2: after actually watching — activates exposures and pushes cards.
    // "Mark watched" pushes the selected cards to Anki; "Watched · no cards" is
    // the disliked-it branch: same close-out, deck untouched (rate it so the
    // dislike is on record). The downloaded video is deliberately NOT deleted
    // here — it stays on the device for rewatch / passive listening until you
    // delete it explicitly (swipe-delete on a queue or Listen row). This is
    // what lets the queue's "🎧 passive" shelve keep the mp4 instead of forcing
    // a re-download. phone-side cleanup (prep cache + marks) + the
    // rate-while-fresh auto-return, shared by the online and offline close-outs.
    const localCloseOut = async () => {
      deleteCachedPrep(episodeId); // light cleanup; the on-disk video + sidecars stay
      cancelTapSync(episodeId); // a late debounce must not re-freeze cleared taps
      clearTaps(episodeId);
      clearSubmitted(episodeId);
      tapStatus.textContent = "";
      // rate + tag while the impression is fresh; touching the rating cancels
      // the auto-return so there's time to pick tags (else the queue row keeps
      // the control). Reset here so only a *post-watch* touch counts.
      engaged = false;
      setTimeout(() => {
        if (!engaged) location.hash = "#/queue";
      }, 12000);
    };

    // `passive` = the "🎧 + listen" branch: same watched close-out, plus the
    // episode is shelved straight onto the Listen tab. The downloaded video is
    // retained either way now (deletion is manual), so this only toggles the
    // shelf — its audio plays off the device with no re-download.
    const finishWatched = async (pushCards: boolean, passive = false) => {
      watchedBtn.disabled = true;
      listenBtn.disabled = true;
      noCardsBtn.disabled = true;
      const reenable = () => {
        watchedBtn.disabled = false;
        listenBtn.disabled = false;
        noCardsBtn.disabled = false;
      };
      try {
        // any mark still debouncing goes first — on the wire when online,
        // ahead of the watched action in the outbox (FIFO) when not
        await syncTapsNow(episodeId);
        const res = await api.markWatched(episodeId, pushCards);
        const c = res.cards;
        if (c?.error) {
          // pre-async servers pushed synchronously and could fail right here
          barStatus.textContent = `watched ✔ but cards failed: ${c.error} — tap again to retry`;
          reenable();
          return;
        }
        // shelve onto the Listen tab once the watch has landed (the /passive
        // route only accepts a watched episode). Best-effort: a failure here
        // leaves a normal watched row the user can still shelve from the queue.
        if (passive) await api.setPassive(episodeId, true).catch(() => {});
        // the push runs server-side in the background — the queue row narrates
        // it (`pushing` → `watched`) and carries any failure + retry
        const base = !pushCards
          ? "watched ✔ · no cards pushed"
          : c?.queued
            ? `watched ✔ · pushing ${c.queued} cards in the background (see queue)`
            : `watched ✔ · ${c?.note ?? "no cards"}`;
        barStatus.textContent = passive ? `${base} · 🎧 on Listen · rate it?` : `${base} · rate it?`;
        await localCloseOut();
      } catch (e) {
        // unreachable (no HTTP status) → the watch still counts: queue the
        // close-out in the outbox (after any pending tap batches — FIFO) and
        // clean up the phone now; the server catches up at the next sync
        if (e instanceof ApiError && e.status === undefined) {
          queueWatched(episodeId, pushCards);
          if (passive) queuePassive(episodeId, true); // after watched — FIFO
          barStatus.textContent = passive
            ? "watched ✔ · 🎧 on Listen · queued offline — syncs when reachable · rate it?"
            : "watched ✔ queued offline — syncs when reachable · rate it?";
          await localCloseOut();
          return;
        }
        barStatus.textContent = `⚠ ${(e as Error).message}`;
        reenable();
      }
    };
    watchedBtn.addEventListener("click", () => void finishWatched(true));
    listenBtn.addEventListener("click", () => void finishWatched(true, true));
    noCardsBtn.addEventListener("click", () => void finishWatched(false));
  }

  void load();
  return root;
}
