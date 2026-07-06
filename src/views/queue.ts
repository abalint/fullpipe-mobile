// Queue screen: enqueue box, live job list from the server, and — when the
// server is unreachable — the offline list of cached prep docs so watch-time
// never depends on connectivity.

import { api, ApiError } from "../api";
import {
  cachedPrepIds,
  clearSubmitted,
  clearTaps,
  deleteCachedPrep,
  getCachedPrep,
  removeEpisodeBatches,
} from "../store";
import { deleteVideo, downloadVideo, getVideoRecord, playVideo } from "../video";
import type { Job, JobState } from "../types";

const STAGE1: JobState[] = ["downloading", "transcribing", "tokenizing"];
// states where Stage 1 has (or may have) a staged video on the server
const HAS_VIDEO: JobState[] = ["prepared", "staged", "reconciled"];
// curated and unwatched — what counts toward the backlog-hours readout
const STAGED_UNWATCHED: JobState[] = ["staged", "reconciled"];

/** Seconds → hh:mm:ss for the unwatched-backlog readout. */
export function hms(seconds: number): string {
  const s = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
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
function swipeable(content: HTMLElement, onDelete: () => void): HTMLElement {
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
    buttons appear (multi-select). Writes are debounced and append a review to
    the taste log — re-rating never overwrites; the on-read verdict takes the
    latest. `onInteract` fires synchronously on any tap (lets the prep view
    cancel its post-watch auto-return). */
export function ratingBlock(
  episodeId: string,
  initialRating: number | null | undefined,
  initialTags: string[],
  onError: (e: Error) => void,
  onInteract?: () => void,
): HTMLElement {
  const wrap = el("div", "rating");
  let rating: number | null = initialRating ?? null;
  const tags = new Set<string>(initialTags);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = () => {
    if (timer) clearTimeout(timer);
    const r = rating;
    const t = [...tags];
    timer = setTimeout(() => {
      void api.rate(episodeId, r, t).catch((e) => onError(e as Error));
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

function jobRow(job: Job, rerender: () => void): HTMLElement {
  const row = el("div", "job");
  const main = el("div", "job-main");
  main.appendChild(el("div", "job-title", job.title || job.source || job.episode_id));
  const sub = el("div", "job-sub");
  const chip = el("span", `chip st-${job.state}`, job.state);
  sub.appendChild(chip);
  if (STAGE1.includes(job.state) && job.progress != null)
    sub.appendChild(el("span", "muted", ` ${Math.round(job.progress * 100)}%`));
  if (job.state === "failed" && job.error)
    sub.appendChild(el("span", "err", ` ${job.error.slice(0, 120)}`));
  main.appendChild(sub);
  // ratable once curation has written the episode to the ledger — including
  // before watched, so a dud can be rated and swiped away without ever
  // pushing its cards
  if (job.state === "staged" || job.state === "reconciled" || job.state === "watched") {
    // ratingBlock keeps its own state (star + tags) so tapping never triggers a
    // full list reload that would collapse the picker mid-selection.
    main.appendChild(
      ratingBlock(job.episode_id, job.rating, job.tags ?? [], (e) => alert(e.message)),
    );
  }
  row.appendChild(main);

  const actions = el("div", "job-actions");
  if (job.state === "prepared") {
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
  if (job.state === "staged" || job.state === "watched" || job.state === "reconciled") {
    const open = el("a", "small btn", "prep") as HTMLAnchorElement;
    open.href = `#/prep/${encodeURIComponent(job.episode_id)}`;
    actions.appendChild(open);
  }
  // video: download once Stage 1 has it, then hand off to VLC
  if (HAS_VIDEO.includes(job.state)) {
    const ep = job.episode_id;
    if (getVideoRecord(ep)) {
      const play = el("button", "small", "▶ VLC") as HTMLButtonElement;
      play.addEventListener("click", () => {
        void playVideo(ep, job.title).catch((e) => alert((e as Error).message));
      });
      actions.appendChild(play);
    } else {
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

/** Delete everywhere: server first (artifacts + queue row + unwatched-ledger
    unwind happen there), then every local trace. Server failure keeps local
    state intact so the row stays visible for retry. */
async function removeJob(job: Job, reload: () => void): Promise<void> {
  const name = job.title || job.source || job.episode_id;
  if (!confirm(`Delete "${name}"?\nRemoves the video, prep doc, and all server artifacts.`))
    return;
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
  removeEpisodeBatches(ep);
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
      alert((err as Error).message);
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

  async function load(): Promise<void> {
    status.textContent = "loading…";
    list.textContent = "";
    backlog.textContent = "";
    try {
      jobs = await api.listJobs();
      status.textContent = jobs.length ? "" : "queue is empty";
      const total = jobs
        .filter((j) => STAGED_UNWATCHED.includes(j.state))
        .reduce((sum, j) => sum + (j.duration ?? 0), 0);
      if (total > 0) backlog.textContent = hms(total);
      const rerender = () => void load();
      jobs.forEach((j) =>
        list.appendChild(swipeable(jobRow(j, rerender), () => void removeJob(j, rerender))),
      );
    } catch (e) {
      jobs = [];
      const msg = e instanceof ApiError ? e.message : String(e);
      status.textContent = `⚠ offline — ${msg}`;
      // offline fallback: anything already cached is still fully usable
      const ids = cachedPrepIds();
      if (ids.length) {
        list.appendChild(el("h2", "", "Cached prep docs"));
        ids.forEach((id) => {
          const doc = getCachedPrep(id);
          const row = el("div", "job");
          const a = el("a", "job-title", doc?.episode.title || id) as HTMLAnchorElement;
          a.href = `#/prep/${encodeURIComponent(id)}`;
          row.appendChild(a);
          list.appendChild(row);
        });
      }
    }
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
  toolbar.append(refresh, dlAll, backlog);
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
