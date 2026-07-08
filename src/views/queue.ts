// Queue screen: enqueue box, live job list from the server, and — when the
// server is unreachable — the same list rebuilt from the last cached snapshot,
// with the offline-capable actions (play the downloaded video, open the cached
// prep, rate, mark watched) still live and server-only ones hidden. Pending
// outbox actions overlay the rows so a queued mark-watched reads as watched.

import { api, ApiError } from "../api";
import {
  cachedPrepIds,
  cacheJobs,
  cachePrep,
  clearSubmitted,
  clearTaps,
  deleteCachedPrep,
  getCachedJobs,
  getCachedPrep,
  hasPendingActions,
  pendingEnqueues,
  pendingPassive,
  pendingRating,
  pendingWatched,
  queueEnqueue,
  queueRating,
  removeEpisodeActions,
} from "../store";
import { flushOutbox } from "../sync";
import { deleteVideo, downloadVideo, getPosition, getVideoRecord } from "../video";
import type { Job, JobState } from "../types";

const STAGE1: JobState[] = ["downloading", "transcribing", "tokenizing"];
// states where Stage 1 has (or may have) a staged video on the server
const HAS_VIDEO: JobState[] = ["prepared", "staged", "reconciled"];
// curated and unwatched — what counts toward the backlog-hours readout
const STAGED_UNWATCHED: JobState[] = ["staged", "reconciled"];
// the server is actively working these — the list auto-refreshes while any exist
// (curating is excluded: it waits on a human /immerse and can sit for hours)
const ACTIVE: JobState[] = ["queued", ...STAGE1, "pushing"];
// episode exists in the ledger → stars/tags make sense (pushing included: the
// close-out runs right when the impression is freshest)
const RATABLE: JobState[] = ["staged", "reconciled", "pushing", "watched"];

/** Whether a job belongs on the Listen tab — the server flag, overlaid with a
    still-unsynced offline shelve/un-shelve so the row moves the moment you tap. */
export function isPassive(job: Job): boolean {
  const pending = pendingPassive(job.episode_id);
  return pending ?? !!job.passive;
}

/** Seconds → hh:mm:ss for the unwatched-backlog readout. */
export function hms(seconds: number): string {
  const s = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Seconds → compact "1h12m" / "38m" for a queue row. */
export function fmtDur(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return "<1m";
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

export type QueueSort = "newest" | "oldest" | "comp-desc" | "comp-asc" | "longest" | "shortest";
const SORT_KEY = "fp.queue.sort";
const SORT_OPTIONS: [QueueSort, string][] = [
  ["newest", "newest first"],
  ["oldest", "oldest first"],
  ["comp-desc", "easiest first"],
  ["comp-asc", "hardest first"],
  ["longest", "longest first"],
  ["shortest", "shortest first"],
];

/** Sort for the queue list. Metric sorts put rows without the metric (no
    coverage/duration staged yet) at the bottom; ties fall back to newest. */
export function sortJobs(jobs: Job[], sort: QueueSort): Job[] {
  const created = (j: Job) => j.created_at ?? "";
  const newest = (a: Job, b: Job) => created(b).localeCompare(created(a));
  const metric =
    (get: (j: Job) => number | null | undefined, desc: boolean) => (a: Job, b: Job) => {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) return newest(a, b);
      if (va == null) return 1;
      if (vb == null) return -1;
      return (desc ? vb - va : va - vb) || newest(a, b);
    };
  const cmp = {
    newest,
    oldest: (a: Job, b: Job) => -newest(a, b),
    "comp-desc": metric((j) => j.comprehensibility, true),
    "comp-asc": metric((j) => j.comprehensibility, false),
    longest: metric((j) => j.duration, true),
    shortest: metric((j) => j.duration, false),
  }[sort];
  return [...jobs].sort(cmp);
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Standard swipe-to-delete: drag the row left to reveal a delete button
    underneath on the right; release past half-open snaps it open. Vertical
    movement wins early so list scrolling is never hijacked. */
export function swipeable(content: HTMLElement, onDelete: () => void): HTMLElement {
  const wrap = el("div", "swipe");
  const del = el("button", "swipe-del", "delete") as HTMLButtonElement;
  del.addEventListener("click", onDelete);
  content.classList.add("swipe-content");
  wrap.append(del, content);

  const WIDTH = 88; // matches .swipe-del in style.css
  let startX = 0;
  let startY = 0;
  let open = false;
  let dragging = false;
  let suppressClick = false;
  let x = 0;

  const settle = (toOpen: boolean) => {
    open = toOpen;
    x = toOpen ? -WIDTH : 0;
    content.style.transition = "transform .18s ease";
    content.style.transform = `translateX(${x}px)`;
  };

  content.addEventListener(
    "touchstart",
    (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dragging = false;
    },
    { passive: true },
  );
  content.addEventListener(
    "touchmove",
    (e) => {
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < 10 || Math.abs(dy) > Math.abs(dx)) return;
        dragging = true;
      }
      x = Math.max(-WIDTH - 24, Math.min(0, (open ? -WIDTH : 0) + dx));
      content.style.transition = "none";
      content.style.transform = `translateX(${x}px)`;
    },
    { passive: true },
  );
  content.addEventListener("touchend", () => {
    if (!dragging) return;
    suppressClick = true; // the drag's tail click must not hit row buttons
    settle(x < -WIDTH / 2);
  });
  // a plain tap on an open row closes it; a post-drag click is swallowed
  content.addEventListener(
    "click",
    (e) => {
      if (suppressClick) {
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
      } else if (open) {
        e.preventDefault();
        e.stopPropagation();
        settle(false);
      }
    },
    true,
  );
  return wrap;
}

/** 5 tappable stars. Tap sets the rating; tapping the current rating clears
    it. Server-side this lands on the ledger's episodes row (taste data for
    future curation) and survives the queue row's deletion — watched episodes
    keep their whole ledger row, unwatched-but-rated ones keep a rating-only
    tombstone. */
export function starBar(rating: number | null | undefined, onRate: (r: number | null) => void): HTMLElement {
  const bar = el("div", "stars");
  for (let n = 1; n <= 5; n++) {
    const filled = rating != null && n <= rating;
    const b = el("button", `star${filled ? " on" : ""}`, filled ? "★" : "☆") as HTMLButtonElement;
    b.addEventListener("click", () => onRate(n === rating ? null : n));
    bar.appendChild(b);
  }
  return bar;
}

// The six taste tags (fullPipe DESIGN.md — Taste metadata), grouped by valence.
// Shown in full whenever a rating exists (never valence-filtered): the
// informative combos are cross-valence, e.g. 4★ · Fascinating · Over my head.
const TAG_GROUPS: { key: string; label: string; tags: [string, string][] }[] = [
  { key: "pos", label: "liked", tags: [["fascinating", "Fascinating"], ["loved_format", "Loved the format"]] },
  {
    key: "neg",
    label: "didn't",
    tags: [
      ["already_knew", "Already knew it"],
      ["over_my_head", "Over my head"],
      ["didnt_grab", "Didn't grab me"],
      ["format_miss", "Format didn't land"],
    ],
  },
];

/** Stars + the optional tag picker as one self-contained control. Star sets
    the rating (re-tap clears, which also clears tags); once rated, the six tag
    buttons appear (multi-select). Writes are debounced, go through the outbox
    (offline they just wait; the client review_id keeps replays idempotent),
    and append a review to the taste log — re-rating never overwrites; the
    on-read verdict takes the latest. A pending unsynced review overrides the
    initial values so an offline re-open shows what you actually picked.
    `onInteract` fires synchronously on any tap (lets the prep view cancel its
    post-watch auto-return); `onQueued` fires when the review couldn't reach
    the server and is waiting in the outbox. */
export function ratingBlock(
  episodeId: string,
  initialRating: number | null | undefined,
  initialTags: string[],
  onInteract?: () => void,
  onQueued?: () => void,
): HTMLElement {
  const wrap = el("div", "rating");
  const pending = pendingRating(episodeId);
  let rating: number | null = pending ? pending.rating : (initialRating ?? null);
  const tags = new Set<string>(pending ? pending.tags : initialTags);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = () => {
    if (timer) clearTimeout(timer);
    const r = rating;
    const t = [...tags];
    timer = setTimeout(() => {
      queueRating(episodeId, r, t);
      void flushOutbox().then((res) => {
        if (res.error && pendingRating(episodeId)) onQueued?.();
      });
    }, 450); // coalesce rapid taps into a single review batch
  };

  const tagWrap = el("div", "tagpicker");
  const tagButtons = new Map<string, HTMLButtonElement>();
  for (const group of TAG_GROUPS) {
    const g = el("div", `taggroup ${group.key}`);
    g.appendChild(el("span", "taglabel", group.label));
    for (const [slug, label] of group.tags) {
      const b = el("button", "tag", label) as HTMLButtonElement;
      if (tags.has(slug)) b.classList.add("on");
      b.addEventListener("click", () => {
        onInteract?.();
        if (tags.has(slug)) tags.delete(slug);
        else tags.add(slug);
        b.classList.toggle("on", tags.has(slug));
        send();
      });
      tagButtons.set(slug, b);
      g.appendChild(b);
    }
    tagWrap.appendChild(g);
  }
  const showTags = () => (tagWrap.style.display = rating == null ? "none" : "");

  const starsHost = el("div");
  const renderStars = () => {
    starsHost.textContent = "";
    starsHost.appendChild(
      starBar(rating, (r) => {
        onInteract?.();
        rating = r; // starBar resolved re-tap-to-clear already
        if (rating == null) {
          tags.clear();
          for (const b of tagButtons.values()) b.classList.remove("on");
        }
        renderStars();
        showTags();
        send();
      }),
    );
  };

  renderStars();
  showTags();
  wrap.append(starsHost, tagWrap);
  return wrap;
}

function jobRow(
  job: Job,
  rerender: () => void,
  onRatingTouch?: () => void,
  offline = false,
): HTMLElement {
  const row = el("div", "job");
  const main = el("div", "job-main");
  main.appendChild(el("div", "job-title", job.title || job.source || job.episode_id));
  const sub = el("div", "job-sub");
  // a queued-offline mark-watched overlays the (stale) snapshot state — the
  // row reads as done, with the pending chip saying the server doesn't know yet
  const state = pendingWatched(job.episode_id) && job.state !== "watched" ? "watched" : job.state;
  const chip = el("span", `chip st-${state}`, state);
  sub.appendChild(chip);
  if (hasPendingActions(job.episode_id)) sub.appendChild(el("span", "chip pending", "⇪ pending sync"));
  if (job.duration) sub.appendChild(el("span", "muted", ` ${fmtDur(job.duration)}`));
  if (job.comprehensibility != null)
    sub.appendChild(el("span", "muted", ` · ${Math.round(job.comprehensibility * 100)}% comp`));
  if (STAGE1.includes(job.state) && job.progress != null)
    sub.appendChild(el("span", "muted", ` ${Math.round(job.progress * 100)}%`));
  // live narration from the worker / card push ("pushing card 3/12")
  if ((STAGE1.includes(job.state) || job.state === "pushing") && job.progress_msg)
    sub.appendChild(el("span", "muted", ` · ${job.progress_msg}`));
  // errors can ride on any state now (e.g. watched + "cards failed" → retry)
  if (job.error) sub.appendChild(el("span", "err", ` ${job.error.slice(0, 120)}`));
  main.appendChild(sub);

  // partway through watching → thin progress bar + where it resumes
  const pos = getPosition(job.episode_id);
  if (pos != null && pos > 0 && job.duration) {
    sub.appendChild(el("span", "muted", ` · at ${hms(pos).replace(/^00:/, "")}`));
    const bar = el("div", "watchbar");
    const fill = el("div", "watchbar-fill");
    fill.style.width = `${Math.min(100, (pos / job.duration) * 100).toFixed(1)}%`;
    bar.appendChild(fill);
    main.appendChild(bar);
  }

  // ratable once curation has written the episode to the ledger — including
  // before watched, so a dud can be rated and swiped away without ever
  // pushing its cards
  if (RATABLE.includes(state)) {
    // ratingBlock keeps its own state (star + tags) so tapping never triggers a
    // full list reload that would collapse the picker mid-selection.
    main.appendChild(ratingBlock(job.episode_id, job.rating, job.tags ?? [], onRatingTouch));
  }
  row.appendChild(main);

  const actions = el("div", "job-actions");
  // watched → offer to shelve it into the passive-listening collection
  // (Listen tab); the row leaves this list but keeps all its artifacts
  if (!offline && job.state === "watched") {
    const shelve = el("button", "small", "🎧 passive") as HTMLButtonElement;
    shelve.addEventListener("click", async () => {
      shelve.disabled = true;
      try {
        await api.setPassive(job.episode_id, true);
      } catch (e) {
        alert((e as Error).message);
      }
      rerender();
    });
    actions.appendChild(shelve);
  }
  // the background card push failed — same retry the prep screen offers
  if (!offline && job.state === "watched" && job.error) {
    const retry = el("button", "small", "retry cards") as HTMLButtonElement;
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        await api.markWatched(job.episode_id, true);
      } catch (e) {
        alert((e as Error).message);
      }
      rerender();
    });
    actions.appendChild(retry);
  }
  // Stage 1 failed (download/transcribe/tokenize) — re-queue it. Without this
  // a transient yt-dlp/network failure could only be cleared by deleting the
  // row and re-pasting the URL.
  if (!offline && job.state === "failed") {
    const retry = el("button", "small", "↻ retry") as HTMLButtonElement;
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        await api.retryJob(job.episode_id);
      } catch (e) {
        alert((e as Error).message);
      }
      rerender();
    });
    actions.appendChild(retry);
  }
  if (!offline && job.state === "prepared") {
    const b = el("button", "small", "curate") as HTMLButtonElement;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api.curate(job.episode_id);
      } catch (e) {
        alert((e as Error).message);
      }
      rerender();
    });
    actions.appendChild(b);
  }
  if (
    ["staged", "reconciled", "pushing", "watched"].includes(job.state) &&
    (!offline || getCachedPrep(job.episode_id))
  ) {
    const open = el("a", "small btn", "prep") as HTMLAnchorElement;
    open.href = `#/prep/${encodeURIComponent(job.episode_id)}`;
    actions.appendChild(open);
  }
  // video: download once Stage 1 has it, then play in-app
  if (HAS_VIDEO.includes(job.state)) {
    const ep = job.episode_id;
    if (getVideoRecord(ep)) {
      const play = el("a", "small btn", pos != null && pos > 0 ? "▶ resume" : "▶ play") as HTMLAnchorElement;
      play.href = `#/player/${encodeURIComponent(ep)}`;
      actions.appendChild(play);
    } else if (!offline) {
      const dl = el("button", "small", "⬇ video") as HTMLButtonElement;
      dl.addEventListener("click", async () => {
        dl.disabled = true;
        try {
          await downloadVideo(ep, (frac, bytes) => {
            dl.textContent = frac != null
              ? `⬇ ${Math.round(frac * 100)}%`
              : `⬇ ${Math.round(bytes / 1e6)} MB`;
          });
          rerender();
        } catch (e) {
          dl.textContent = "⬇ video";
          dl.disabled = false;
          alert(`download failed: ${(e as Error).message}`);
        }
      });
      actions.appendChild(dl);
    }
  }
  row.appendChild(actions);
  return row;
}

/** What deleting this row actually costs, so the confirm isn't a mystery.
    Mirrors the server's purge rules (app.py delete_job / purge_episode). */
function deleteMessage(job: Job): string {
  const name = job.title || job.source || job.episode_id;
  if (job.state === "watched")
    return (
      `Delete "${name}"?\n\nAlready watched ✔ — its Anki cards and ledger history are kept. ` +
      `This only clears the video and prep files off the server. Safe.`
    );
  if (job.state === "staged" || job.state === "reconciled")
    return (
      `Delete "${name}"?\n\nNOT watched yet — no cards were pushed, and its ledger traces ` +
      `(submitted feedback included) will be unwound.` +
      (job.rating != null ? "\nThe star rating is kept." : "")
    );
  return `Delete "${name}"?\nRemoves the download and all server artifacts. Nothing has been mined from it.`;
}

/** Delete everywhere: server first (artifacts + queue row + unwatched-ledger
    unwind happen there), then every local trace. Server failure keeps local
    state intact so the row stays visible for retry. */
export async function removeJob(job: Job, reload: () => void, offline = false): Promise<void> {
  if (offline) {
    alert("Offline — deleting removes server artifacts, so it needs the server reachable.");
    return;
  }
  if (job.state === "pushing") {
    alert("Cards are being pushed to Anki for this episode — wait for it to finish, then delete.");
    return;
  }
  if (STAGE1.includes(job.state)) {
    alert(`Still ${job.state} — let Stage 1 finish or fail first, then delete.`);
    return;
  }
  if (!confirm(deleteMessage(job))) return;
  try {
    await api.deleteJob(job.episode_id);
  } catch (e) {
    alert(`delete failed: ${(e as Error).message}`);
    return;
  }
  const ep = job.episode_id;
  await deleteVideo(ep).catch(() => {}); // may never have been downloaded
  deleteCachedPrep(ep);
  clearTaps(ep);
  clearSubmitted(ep);
  removeEpisodeActions(ep);
  reload();
}

export function queueView(): HTMLElement {
  const root = el("div", "view");

  // enqueue box (share-sheet lands here too, via ?share= — wired later)
  const form = el("form", "enqueue") as HTMLFormElement;
  const input = el("input") as HTMLInputElement;
  input.type = "url";
  input.placeholder = "paste a video URL to queue";
  const add = el("button", "primary", "Queue") as HTMLButtonElement;
  add.type = "submit";
  form.append(input, add);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const source = input.value.trim();
    if (!source) return;
    add.disabled = true;
    try {
      await api.enqueue(source);
      input.value = "";
      await load();
    } catch (err) {
      // unreachable (no HTTP status) → park it in the outbox; POST /jobs is
      // idempotent by source so the eventual flush is safe
      if (err instanceof ApiError && err.status === undefined) {
        queueEnqueue(source);
        input.value = "";
        render();
      } else {
        alert((err as Error).message);
      }
    } finally {
      add.disabled = false;
    }
  });
  root.appendChild(form);

  const status = el("div", "status");
  const list = el("div", "joblist");
  root.append(status, list);

  // hours of staged-and-unwatched content, so "is tonight covered?" is one glance
  const backlog = el("span", "backlog");

  let jobs: Job[] = [];
  let offline = false;
  let pollTimer: number | undefined;
  let lastRatingTouch = 0;

  const sortSel = el("select", "small sort") as HTMLSelectElement;
  for (const [value, label] of SORT_OPTIONS) {
    const o = el("option", "", label) as HTMLOptionElement;
    o.value = value;
    sortSel.appendChild(o);
  }
  const savedSort = localStorage.getItem(SORT_KEY) as QueueSort | null;
  sortSel.value = savedSort && SORT_OPTIONS.some(([v]) => v === savedSort) ? savedSort : "newest";
  sortSel.addEventListener("change", () => {
    localStorage.setItem(SORT_KEY, sortSel.value);
    render();
  });

  function render(): void {
    if (!offline) status.textContent = jobs.some((j) => !isPassive(j)) ? "" : "queue is empty";
    list.textContent = "";
    const total = jobs
      .filter((j) => STAGED_UNWATCHED.includes(j.state))
      .reduce((sum, j) => sum + (j.duration ?? 0), 0);
    backlog.textContent = total > 0 ? hms(total) : "";
    const rerender = () => void load();
    const onRatingTouch = () => (lastRatingTouch = Date.now());
    // sources queued while unreachable, waiting in the outbox
    for (const source of pendingEnqueues()) {
      const row = el("div", "job");
      const main = el("div", "job-main");
      main.appendChild(el("div", "job-title", source));
      const sub = el("div", "job-sub");
      sub.appendChild(el("span", "chip pending", "⇪ will queue on sync"));
      main.appendChild(sub);
      row.appendChild(main);
      list.appendChild(row);
    }
    // passive-shelved episodes live on the Listen tab, not here
    for (const j of sortJobs(jobs.filter((j) => !isPassive(j)), sortSel.value as QueueSort))
      list.appendChild(
        swipeable(jobRow(j, rerender, onRatingTouch, offline), () =>
          void removeJob(j, rerender, offline),
        ),
      );
    // cached prep docs with no queue row (snapshot predates them / demo doc)
    // stay reachable offline
    if (offline) {
      const known = new Set(jobs.map((j) => j.episode_id));
      const orphans = cachedPrepIds().filter((id) => !known.has(id));
      if (orphans.length) {
        list.appendChild(el("h2", "", "Cached prep docs"));
        for (const id of orphans) {
          const row = el("div", "job");
          const a = el("a", "job-title", getCachedPrep(id)?.episode.title || id) as HTMLAnchorElement;
          a.href = `#/prep/${encodeURIComponent(id)}`;
          row.appendChild(a);
          list.appendChild(row);
        }
      }
    }
  }

  /** Pull prep docs for every curated episode in the background so "staged
      while online" implies "prep readable offline" — not only after a manual
      open. Skips docs that already carry their curation; refetches ones
      cached back at `prepared` (pre-curation). */
  async function cacheStagedPreps(): Promise<boolean> {
    let fetched = false;
    for (const j of jobs) {
      if (!STAGED_UNWATCHED.includes(j.state)) continue;
      const cached = getCachedPrep(j.episode_id);
      if (cached?.curate) continue;
      try {
        cachePrep(await api.getPrep(j.episode_id));
        fetched = true;
      } catch {
        /* best-effort — next queue load retries */
      }
    }
    return fetched;
  }

  /** While the server is actively working (Stage 1, card push), refresh the
      list every few seconds so progress narrates itself — but never rebuild
      it under an in-progress star/tag selection. Stops when the view is
      swapped out, nothing is active, or the server is unreachable (a cached
      snapshot can hold "active" states that aren't advancing). */
  function schedulePoll(): void {
    if (pollTimer) clearTimeout(pollTimer);
    if (offline || !jobs.some((j) => ACTIVE.includes(j.state))) return;
    pollTimer = window.setTimeout(() => {
      if (!root.isConnected) return;
      if (Date.now() - lastRatingTouch < 15000) return schedulePoll();
      void load(true);
    }, 2500);
  }

  async function load(silent = false): Promise<void> {
    if (!silent) {
      // Paint the cached queue immediately, showing only the offline-safe
      // actions, so the list is usable while we probe the server. A dead or
      // unreachable host no longer blanks the screen behind "loading…" until
      // the fetch deadline — the live list (and online-only actions) swap in
      // the moment the fetch returns. Skipped once jobs are already on screen
      // (a manual refresh keeps the current list visible under "loading…").
      if (!jobs.length) {
        const snap = getCachedJobs();
        if (snap) {
          jobs = snap.jobs;
          offline = true;
          render();
          status.textContent = `loading… · cached queue from ${new Date(snap.at).toLocaleString()}`;
        } else {
          status.textContent = "loading…";
        }
      } else {
        status.textContent = "loading…";
      }
    }
    try {
      jobs = await api.listJobs();
      offline = false;
      cacheJobs(jobs); // snapshot for the offline queue screen
      render();
      void cacheStagedPreps().then((fetched) => {
        if (fetched && root.isConnected && !offline) render(); // prep buttons may appear
      });
    } catch (e) {
      // offline fallback: rebuild the queue from the last snapshot — cached
      // preps, downloaded videos, rating and mark-watched all still work (the
      // writes wait in the outbox)
      offline = true;
      const snap = getCachedJobs();
      jobs = snap?.jobs ?? [];
      const msg = e instanceof ApiError ? e.message : String(e);
      status.textContent = snap
        ? `⚠ offline — cached queue from ${new Date(snap.at).toLocaleString()}`
        : `⚠ offline — ${msg}`;
      render();
    }
    schedulePoll();
  }

  const toolbar = el("div", "toolbar");
  const refresh = el("button", "small refresh", "↻ refresh") as HTMLButtonElement;
  refresh.addEventListener("click", () => void load());
  const dlAll = el("button", "small", "⬇ all videos") as HTMLButtonElement;
  dlAll.addEventListener("click", async () => {
    const pending = jobs.filter(
      (j) => HAS_VIDEO.includes(j.state) && !getVideoRecord(j.episode_id),
    );
    if (!pending.length) {
      dlAll.textContent = "nothing to download";
      setTimeout(() => (dlAll.textContent = "⬇ all videos"), 1500);
      return;
    }
    dlAll.disabled = true;
    const failed: string[] = [];
    for (let i = 0; i < pending.length; i++) {
      const label = `⬇ ${i + 1}/${pending.length}`;
      dlAll.textContent = label;
      try {
        await downloadVideo(pending[i].episode_id, (frac, bytes) => {
          dlAll.textContent = frac != null
            ? `${label} · ${Math.round(frac * 100)}%`
            : `${label} · ${Math.round(bytes / 1e6)} MB`;
        });
      } catch (e) {
        failed.push(`${pending[i].title || pending[i].episode_id}: ${(e as Error).message}`);
      }
    }
    dlAll.disabled = false;
    dlAll.textContent = "⬇ all videos";
    if (failed.length) alert(`some downloads failed:\n${failed.join("\n")}`);
    void load();
  });
  toolbar.append(refresh, dlAll, sortSel, backlog);
  root.insertBefore(toolbar, status);

  void load();

  // a URL shared into the app lands here → enqueue it straight away
  const shared = sessionStorage.getItem("fp.pendingShare");
  if (shared) {
    sessionStorage.removeItem("fp.pendingShare");
    input.value = shared;
    form.requestSubmit(); // on failure the URL stays in the box for retry
  }

  return root;
}
