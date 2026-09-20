// Queue screen: enqueue box, live job list from the server, and — when the
// server is unreachable — the same list rebuilt from the last cached snapshot,
// with the offline-capable actions (play the downloaded video, rate) still
// live and server-only ones hidden. Pending outbox actions overlay the rows so
// a queued close-out reads as watched.

import { api, ApiError } from "../api";
import { cancelTapSync } from "../livesync";
import {
  cacheJobs,
  cachePrep,
  clearSubmitted,
  clearTaps,
  deleteCachedPrep,
  getCachedJobs,
  getCachedPrep,
  getViewLog,
  hasPendingActions,
  pendingEnqueues,
  pendingPassive,
  pendingRating,
  pendingSeriesRating,
  pendingWatched,
  queueEnqueue,
  queueRating,
  queueSeriesRating,
  removeEpisodeActions,
} from "../store";
import { flushOutbox } from "../sync";
import { isPageSource } from "../pages";
import { epLabel, finishedEpisodes, groupSeries, isDone, isSeries, nextThumb, nextToWatch } from "../series";
import type { SeriesGroup } from "../series";
import { filterJobs, listControls, sortJobs } from "../listfilter";
import { deleteVideo, getPosition, getVideoRecord, refreshSidecars } from "../video";
import {
  activeDownloads,
  bindDownloadButton,
  downloadError,
  downloadStatus,
  startDownload,
  watchDownloads,
} from "../downloads";
import type { FollowState, Job, JobState, SeriesRating } from "../types";
import { FOLLOW_OPTIONS, SURVEY_AXES } from "../types";

const STAGE1: JobState[] = ["downloading", "transcribing", "tokenizing"];
// states where Stage 1 has (or may have) a staged video on the server
const HAS_VIDEO: JobState[] = ["prepared", "staged", "reconciled"];
// a row offers ⬇ in those states, and again once watched (the server keeps
// video.mp4 after the close-out — MOBILE.md retention — so a rewatch is one
// tap; "⬇ all videos" still sweeps only the unwatched set)
const canDownload = (job: Job) => HAS_VIDEO.includes(job.state) || isDone(job);
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

/** Unwatched seconds sitting on this tab. Counts exactly the rows the queue
    lists: passive-shelved episodes belong to the Listen tab, page jobs to the
    Pages tab, and an episode marked watched in the outbox — or already played to
    the end on this phone (`finished`, series.finishedEpisodes) — is done even
    though the snapshot is stale. */
export function backlogSeconds(jobs: Job[], finished?: ReadonlySet<string>): number {
  return jobs
    .filter((j) => j.kind !== "page" && j.kind !== "manga" && !isPassive(j) && !pendingWatched(j.episode_id))
    .filter((j) => STAGED_UNWATCHED.includes(j.state) && !finished?.has(j.episode_id))
    .reduce((sum, j) => sum + (j.duration ?? 0), 0);
}

/** Rows the "⬇ all videos" sweep should fetch: episodes whose Stage-1 video may
    be staged on the server and isn't already on the phone. Page jobs are
    excluded the same way the list itself excludes them — a page has no video
    artifact, so asking for one 404s and lands in the failure alert. */
export function pendingVideoDownloads(jobs: Job[]): Job[] {
  return jobs.filter(
    (j) => j.kind !== "page" && j.kind !== "manga" && HAS_VIDEO.includes(j.state) && !getVideoRecord(j.episode_id),
  );
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

// sort + filter live in listfilter.ts (shared with the Listen tab); re-exported
// so existing imports keep working
export { sortJobs } from "../listfilter";
export type { QueueSort } from "../listfilter";

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

/** A labelled 1-5 pip row (SURVEY.md) — the graded survey axes reuse the star's
    out-of-5 metaphor. Re-tapping the current value clears the axis. */
function pipRow(
  label: string,
  value: number | undefined,
  onSet: (v: number | undefined) => void,
): HTMLElement {
  const row = el("div", "axis");
  row.appendChild(el("span", "axislabel", label));
  const pips = el("div", "pips");
  for (let n = 1; n <= 5; n++) {
    const on = value != null && n <= value;
    const b = el("button", `pip${on ? " on" : ""}`) as HTMLButtonElement;
    b.setAttribute("aria-label", `${label} ${n}`);
    b.addEventListener("click", () => onSet(n === value ? undefined : n));
    pips.appendChild(b);
  }
  row.appendChild(pips);
  return row;
}

/** The post-watch survey (SURVEY.md) as one self-contained control:
    - overall **star** (re-tap clears, which clears the video axes/chips/note);
    - graded **axes** (Topic/Presenter/Audio/Speech/Difficulty), shown once rated;
    - taste **chips** (multi-select);
    - a **note** field; and
    - a **channel follow** control that is ALWAYS shown and survives a star clear
      (it's a per-channel intent, not a video verdict).
    Writes are debounced through the outbox (offline they wait; the client
    review_id keeps replays idempotent) and append a review to the taste log —
    re-rating never overwrites; the on-read verdict takes the latest. A pending
    unsynced review overrides the initial values so an offline re-open shows what
    you actually picked. `onInteract` fires on any tap (lets prep cancel its
    post-watch auto-return); `onQueued` fires when the review is stuck offline. */
export function ratingBlock(
  episodeId: string,
  initialRating: number | null | undefined,
  initialTags: string[],
  onInteract?: () => void,
  onQueued?: () => void,
  initialAxes: Record<string, number> = {},
  initialFollow: FollowState | null = null,
): HTMLElement {
  const wrap = el("div", "rating");
  const pending = pendingRating(episodeId);
  let rating: number | null = pending ? pending.rating : (initialRating ?? null);
  const tags = new Set<string>(pending ? pending.tags : initialTags);
  const axes = new Map<string, number>(Object.entries(pending ? pending.axes : initialAxes));
  let follow: FollowState | null = pending ? pending.follow : initialFollow;
  let note = pending ? pending.note : "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = () => {
    if (timer) clearTimeout(timer);
    const r = rating;
    const t = [...tags];
    const a = Object.fromEntries(axes);
    const f = follow;
    const n = note;
    timer = setTimeout(() => {
      queueRating(episodeId, r, t, a, f, n);
      void flushOutbox().then((res) => {
        if (res.error && pendingRating(episodeId)) onQueued?.();
      });
    }, 450); // coalesce rapid taps into a single review batch
  };

  // --- taste chips ---
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

  // --- graded axes ---
  const axesHost = el("div", "axes");
  const renderAxes = () => {
    axesHost.textContent = "";
    for (const [key, label] of SURVEY_AXES) {
      axesHost.appendChild(
        pipRow(label, axes.get(key), (v) => {
          onInteract?.();
          if (v == null) axes.delete(key);
          else axes.set(key, v);
          renderAxes();
          send();
        }),
      );
    }
  };
  renderAxes();

  // --- free note ---
  const noteBox = el("textarea", "note") as HTMLTextAreaElement;
  noteBox.rows = 2;
  noteBox.placeholder = "a line on why (optional)…";
  noteBox.value = note;
  noteBox.addEventListener("input", () => {
    onInteract?.();
    note = noteBox.value;
    send();
  });

  // Video-scoped controls (axes/chips/note) only make sense once rated.
  const videoWrap = el("div", "videosurvey");
  videoWrap.append(tagWrap, axesHost, noteBox);
  const showVideoSurvey = () => (videoWrap.style.display = rating == null ? "none" : "");

  // --- channel follow (always shown; independent of the star) ---
  const followWrap = el("div", "follow");
  followWrap.appendChild(el("span", "followlabel", "Channel"));
  const followButtons = new Map<FollowState, HTMLButtonElement>();
  for (const [state, label] of FOLLOW_OPTIONS) {
    const b = el("button", `followbtn ${state}`, label) as HTMLButtonElement;
    if (follow === state) b.classList.add("on");
    b.addEventListener("click", () => {
      onInteract?.();
      follow = follow === state ? null : state;
      for (const [s, btn] of followButtons) btn.classList.toggle("on", follow === s);
      send();
    });
    followButtons.set(state, b);
    followWrap.appendChild(b);
  }

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
          axes.clear();
          renderAxes();
          note = "";
          noteBox.value = "";
        }
        renderStars();
        showVideoSurvey();
        send();
      }),
    );
  };

  renderStars();
  showVideoSurvey();
  wrap.append(starsHost, videoWrap, followWrap);
  return wrap;
}

/** A whole-series thumbs verdict (2026-09-20): two buttons, 👎 and 👍. A
    tap on the side you're on toggles single ⇄ double (series.nextThumb);
    the other side switches to its single. Keeps its own state like
    ratingBlock, so tapping never reloads the list; a pending outbox
    verdict overlays the server's. Shared by the series header on the
    queue and the player's close-out for a series episode. */
export function thumbsBlock(
  series: string,
  initial: SeriesRating | null | undefined,
  onInteract?: () => void,
  onQueued?: () => void,
): HTMLElement {
  const wrap = el("div", "thumbs");
  const pending = pendingSeriesRating(series);
  let rating: SeriesRating | null = pending ? pending.rating : (initial ?? null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = () => {
    if (timer) clearTimeout(timer);
    const r = rating;
    timer = setTimeout(() => {
      queueSeriesRating(series, r);
      void flushOutbox().then((res) => {
        if (res.error && pendingSeriesRating(series)) onQueued?.();
      });
    }, 450); // coalesce the 👍 → 👍👍 double-tap into one review
  };
  const buttons: [1 | -1, HTMLButtonElement][] = [];
  const paint = () => {
    for (const [dir, b] of buttons) {
      const on = rating != null && Math.sign(rating) === dir;
      const dbl = on && Math.abs(rating!) === 2;
      b.classList.toggle("on", on);
      b.classList.toggle("dbl", dbl);
      b.textContent = (dir > 0 ? "👍" : "👎").repeat(dbl ? 2 : 1);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };
  for (const dir of [-1, 1] as const) {
    const b = el("button", `thumb ${dir > 0 ? "up" : "down"}`) as HTMLButtonElement;
    b.title = dir > 0 ? "Thumbs up — tap again for double" : "Thumbs down — tap again for double";
    b.addEventListener("click", (e) => {
      e.stopPropagation(); // sits inside the collapsible header
      onInteract?.();
      rating = nextThumb(rating, dir);
      paint();
      send();
    });
    buttons.push([dir, b]);
    wrap.appendChild(b);
  }
  paint();
  return wrap;
}

export function jobRow(
  job: Job,
  rerender: () => void,
  onRatingTouch?: () => void,
  offline = false,
  finished?: ReadonlySet<string>,
): HTMLElement {
  const row = el("div", "job");
  const main = el("div", "job-main");
  main.appendChild(el("div", "job-title", job.title || job.source || job.episode_id));
  const sub = el("div", "job-sub");
  // a queued-offline mark-watched — or (2026-09-20) a sitting this phone has
  // already played past the finished bar (series.finishedEpisodes), which the
  // server won't have acted on until the next /jobs — overlays the (stale)
  // snapshot state: the row reads as done, with the pending chip saying the
  // server doesn't know yet
  const state =
    (pendingWatched(job.episode_id) || finished?.has(job.episode_id)) && job.state !== "watched"
      ? "watched"
      : job.state;
  if (isSeries(job)) sub.appendChild(el("span", "chip ep", epLabel(job)));
  const chip = el("span", `chip st-${state}`, state);
  sub.appendChild(chip);
  if (hasPendingActions(job.episode_id)) sub.appendChild(el("span", "chip pending", "⇪ pending sync"));
  // /immerse's genre label (English, categorical) — set once curated
  if (job.genre) sub.appendChild(el("span", "chip genre", job.genre));
  if (job.duration) sub.appendChild(el("span", "muted", ` ${fmtDur(job.duration)}`));
  if (job.comprehensibility != null)
    sub.appendChild(el("span", "muted", ` · ${Math.round(job.comprehensibility * 100)}% comp`));
  if (STAGE1.includes(job.state) && job.progress != null)
    sub.appendChild(el("span", "muted", ` ${Math.round(job.progress * 100)}%`));
  // live narration from the worker / card push ("pushing card 3/12")
  if ((STAGE1.includes(job.state) || job.state === "pushing") && job.progress_msg)
    sub.appendChild(el("span", "muted", ` · ${job.progress_msg}`));
  const dlErr = downloadError(job.episode_id);
  if (dlErr && !getVideoRecord(job.episode_id))
    sub.appendChild(el("span", "muted warn", ` · ⚠ download failed: ${dlErr}`));
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
  // pushing its cards. Series episodes carry no per-episode survey: the
  // box set is rated as a whole on its header (thumbsBlock, 2026-09-20).
  if (RATABLE.includes(state) && !isSeries(job)) {
    // ratingBlock keeps its own state (star + tags) so tapping never triggers a
    // full list reload that would collapse the picker mid-selection.
    main.appendChild(
      ratingBlock(
        job.episode_id,
        job.rating,
        job.tags ?? [],
        onRatingTouch,
        undefined,
        job.axes ?? {},
        job.follow ?? null,
      ),
    );
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
  // video: download once Stage 1 has it, then play in-app
  if (canDownload(job)) {
    const ep = job.episode_id;
    if (getVideoRecord(ep)) {
      const play = el("a", "small btn", pos != null && pos > 0 ? "▶ resume" : "▶ play") as HTMLAnchorElement;
      play.href = `#/player/${encodeURIComponent(ep)}`;
      actions.appendChild(play);
      // A record can outlive a usable file: the PC re-staged the episode, or
      // the download is there but won't play. Without this the row is stuck on
      // ▶ play forever — the only other way out is swipe-delete, which also
      // purges the server's artifacts. Re-pull in place instead.
      if (!offline) {
        const again = el("button", "small", "↻") as HTMLButtonElement;
        again.title = "re-download video";
        actions.appendChild(bindDownloadButton(again, { ep, title: job.title, idle: "↻" }));
      }
    } else if (!offline || downloadStatus(ep)) {
      // the button paints its own episode's live status (downloads.ts), so a
      // list rebuild mid-download — or a second download beside it — keeps
      // the right number on the right row
      const dl = el("button", "small") as HTMLButtonElement;
      actions.appendChild(bindDownloadButton(dl, { ep, title: job.title, idle: "⬇ video", prefix: "⬇" }));
    }
  }
  row.appendChild(actions);
  return row;
}

/** What deleting this row actually costs, so the confirm isn't a mystery.
    Mirrors the server's purge rules (app.py delete_job / purge_episode). */
function deleteMessage(job: Job): string {
  const name = job.title || job.source || job.episode_id;
  if (isSeries(job))
    return (
      `Remove "${name}" from this phone?\n\nSeries episode — only the downloaded video ` +
      `(and its subtitle sidecars) leave the phone. The PC keeps the video, transcript, ` +
      `prep, cards and ledger history, so ⬇ brings it back for a rewatch anytime.`
    );
  if (job.state === "watched")
    return (
      `Delete "${name}"?\n\nAlready watched ✔ — its Anki cards and ledger history are kept. ` +
      `This only clears the video and prep files off the server. Safe.`
    );
  if (job.state === "staged" || job.state === "reconciled")
    return (
      `Delete "${name}"?\n\nNot finished — no cards were pushed. The words in the parts you ` +
      `played (and your marks) stay in the ledger; the rest of its traces are unwound.` +
      (job.rating != null ? "\nThe star rating is kept." : "")
    );
  return `Delete "${name}"?\nRemoves the download and all server artifacts. Nothing has been mined from it.`;
}

/** Delete everywhere: server first (artifacts + queue row + unwatched-ledger
    unwind happen there), then every local trace. Server failure keeps local
    state intact so the row stays visible for retry. */
export async function removeJob(job: Job, reload: () => void, offline = false): Promise<void> {
  // Series episodes: phone-local only. Nothing on the server is touched
  // (DELETE is refused for them anyway) — taps, cached prep and outbox
  // actions stay too; just the big file goes. Works offline for that reason.
  if (isSeries(job)) {
    if (!getVideoRecord(job.episode_id)) {
      alert("Nothing downloaded for this episode — series rows are removed on the PC (tools.series remove).");
      return;
    }
    if (!confirm(deleteMessage(job))) return;
    await deleteVideo(job.episode_id).catch(() => {});
    reload();
    return;
  }
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
  cancelTapSync(ep); // a debounce still running must not re-freeze the taps
  clearTaps(ep);
  clearSubmitted(ep);
  removeEpisodeActions(ep);
  reload();
}

const collapsedKey = (slug: string) => `fp.series.collapsed.${slug}`;

/** A collapsible shell: caret + title + trailing note over `body`, the open /
    closed state remembered under `key`. Shared by the per-series blocks and
    the section that gathers them. */
function collapsible(
  key: string,
  cls: string,
  title: string,
  note: string,
  defaultCollapsed = false,
): { block: HTMLElement; head: HTMLElement; body: HTMLElement } {
  const block = el("div", cls);
  const stored = localStorage.getItem(key);
  if (stored === "1" || (stored === null && defaultCollapsed)) block.classList.add("collapsed");
  const head = el("div", "series-head");
  const caret = el("span", "muted", block.classList.contains("collapsed") ? "▸" : "▾");
  head.append(caret, el("span", "series-title", title));
  if (note) head.appendChild(el("span", "muted", note));
  head.addEventListener("click", () => {
    const collapsed = block.classList.toggle("collapsed");
    caret.textContent = collapsed ? "▸" : "▾";
    localStorage.setItem(key, collapsed ? "1" : "0");
  });
  const body = el("div", "series-body");
  block.append(head, body);
  return { block, head, body };
}

/** Every series on the queue under one collapsible "Series" header, split
    into two collapsible shelves: series with at least one episode downloaded
    ("On phone") and series with nothing downloaded yet ("Not on phone"). Each
    series stays its own collapsible block inside its shelf. Returns null when
    there are no series to show. */
export function seriesSection(
  groups: SeriesGroup[],
  rerender: () => void,
  onRatingTouch?: () => void,
  offline = false,
  finished?: ReadonlySet<string>,
): HTMLElement | null {
  if (!groups.length) return null;
  const onPhone = groups.filter((g) => g.episodes.some((j) => getVideoRecord(j.episode_id)));
  const elsewhere = groups.filter((g) => !g.episodes.some((j) => getVideoRecord(j.episode_id)));
  const section = collapsible(
    "fp.series.section.collapsed",
    "series-section",
    "Series",
    `${groups.length} · ${onPhone.length} on phone`,
  );
  const shelf = (key: string, title: string, list: SeriesGroup[], defaultCollapsed: boolean) => {
    if (!list.length) return;
    const sub = collapsible(key, "series-shelf", title, `${list.length}`, defaultCollapsed);
    for (const g of list) sub.body.appendChild(seriesBlock(g, rerender, onRatingTouch, offline, finished));
    section.body.appendChild(sub.block);
  };
  shelf("fp.series.shelf.onphone.collapsed", "On phone", onPhone, false);
  shelf("fp.series.shelf.elsewhere.collapsed", "Not on phone", elsewhere, true);
  return section.block;
}

/** One series on the queue: a header (title · progress · resume/download the
    next episode · collapse toggle) over its episodes in playlist order. */
export function seriesBlock(
  g: SeriesGroup,
  rerender: () => void,
  onRatingTouch?: () => void,
  offline = false,
  finished?: ReadonlySet<string>,
): HTMLElement {
  const done = g.episodes.filter((j) => isDone(j, finished)).length;
  const onPhone = g.episodes.filter((j) => getVideoRecord(j.episode_id)).length;
  const { block, head, body } = collapsible(
    collapsedKey(g.slug),
    "series",
    g.title,
    `${done}/${g.episodes.length} watched · ${onPhone} on phone`,
  );
  // resume action: play the next unwatched episode if it's on the phone, else
  // fetch it; a finished set offers a rewatch from the top
  const next = nextToWatch(g, finished) ?? (onPhone ? g.episodes[0] : null);
  if (next) {
    const label = nextToWatch(g, finished) ? epLabel(next) : `↺ ${epLabel(next)}`;
    if (getVideoRecord(next.episode_id)) {
      const play = el("a", "small btn", `▶ ${label}`) as HTMLAnchorElement;
      play.href = `#/player/${encodeURIComponent(next.episode_id)}`;
      play.addEventListener("click", (e) => e.stopPropagation());
      head.appendChild(play);
    } else if ((!offline || downloadStatus(next.episode_id)) && canDownload(next)) {
      const dl = el("button", "small") as HTMLButtonElement;
      head.appendChild(
        bindDownloadButton(dl, { ep: next.episode_id, title: next.title, idle: `⬇ ${label}` }),
      );
    }
  }
  // the whole set's thumbs verdict (every episode row carries it; take the
  // first) — the only rating a series gets (2026-09-20)
  head.appendChild(thumbsBlock(g.slug, g.episodes[0]?.series_rating ?? null, onRatingTouch));
  for (const j of g.episodes)
    body.appendChild(
      swipeable(jobRow(j, rerender, onRatingTouch, offline, finished), () =>
        void removeJob(j, rerender, offline),
      ),
    );
  return block;
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

  // sort select (main toolbar) + status/genre/on-phone filter row; choices
  // persist under fp.queue.*
  const controls = listControls("fp.queue", () => render());

  function render(): void {
    if (!offline) status.textContent = jobs.some((j) => !isPassive(j)) ? "" : "queue is empty";
    list.textContent = "";
    // one pass over the local view log per render, not per row
    const finished = finishedEpisodes(jobs, getViewLog());
    const total = backlogSeconds(jobs, finished);
    backlog.textContent = total > 0 ? hms(total) : "";
    const rerender = () => void load();
    const onRatingTouch = () => (lastRatingTouch = Date.now());
    // sources queued while unreachable, waiting in the outbox (5ch URLs show
    // on the Pages tab instead)
    for (const source of pendingEnqueues().filter((s) => !isPageSource(s))) {
      const row = el("div", "job");
      const main = el("div", "job-main");
      main.appendChild(el("div", "job-title", source));
      const sub = el("div", "job-sub");
      sub.appendChild(el("span", "chip pending", "⇪ will queue on sync"));
      main.appendChild(sub);
      row.appendChild(main);
      list.appendChild(row);
    }
    // passive-shelved episodes live on the Listen tab, page jobs on Pages
    const mine = jobs.filter((j) => j.kind !== "page" && j.kind !== "manga" && !isPassive(j));
    const { sort, filter } = controls.current();
    const shown = sortJobs(filterJobs(mine, filter, undefined, undefined, finished), sort);
    controls.update(mine, shown.length);
    if (!offline && mine.length && !shown.length) status.textContent = "nothing matches the filters";
    const grouped = groupSeries(shown);
    const section = seriesSection(grouped.series, rerender, onRatingTouch, offline, finished);
    if (section) list.appendChild(section);
    for (const j of grouped.standalone)
      list.appendChild(
        swipeable(jobRow(j, rerender, onRatingTouch, offline, finished), () =>
          void removeJob(j, rerender, offline),
        ),
      );
  }

  /** Pull prep docs for every curated episode in the background so "staged
      while online" implies "prep readable offline" — not only after a manual
      open. Skips docs that already carry their curation; refetches ones
      cached back at `prepared` (pre-curation). Downloaded videos get the same
      treatment: transcript/definitions sidecars fetched at `prepared` lack
      the curate pass (grammar/phrase notes, curate-authored defs), so refresh
      them once the episode is staged. */
  async function cacheStagedPreps(): Promise<boolean> {
    let fetched = false;
    for (const j of jobs) {
      if (j.kind === "page" || !STAGED_UNWATCHED.includes(j.state)) continue;
      const cached = getCachedPrep(j.episode_id);
      if (!cached?.curate) {
        try {
          cachePrep(await api.getPrep(j.episode_id));
          fetched = true;
        } catch {
          /* best-effort — next queue load retries */
        }
      }
      try {
        if (await refreshSidecars(j.episode_id)) fetched = true;
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
  const paintDlAll = () => {
    const n = activeDownloads().length;
    dlAll.disabled = n > 0;
    if (n > 0) dlAll.textContent = `⬇ ${n} downloading`;
    else if (dlAll.textContent !== "nothing to download") dlAll.textContent = "⬇ all videos";
  };
  dlAll.addEventListener("click", () => {
    const pending = pendingVideoDownloads(jobs);
    if (!pending.length) {
      dlAll.textContent = "nothing to download";
      setTimeout(() => (dlAll.textContent = "⬇ all videos"), 1500);
      return;
    }
    // hand the whole set to the background queue — it drains one at a time
    // and keeps going when you leave the tab or the app
    for (const j of pending) void startDownload(j.episode_id, j.title);
    render();
    paintDlAll();
  });
  paintDlAll();
  // live download state → repaint the buttons in place; a settled download
  // (done or failed) rebuilds the list so ▶ play / the failure note appear
  watchDownloads(root, (c) => {
    paintDlAll();
    if (!c.status) render();
  });
  toolbar.append(refresh, dlAll, controls.sort, backlog);
  root.insertBefore(toolbar, status);
  root.insertBefore(controls.filters, status);

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
