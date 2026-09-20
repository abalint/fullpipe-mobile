// Read tab: everything read rather than played — manga volumes from the PC
// library (tools.manga; grouped per series in volume order, like box sets
// on the Queue tab) and 5ch threads (queue a URL, read it in the thread
// reader). Manga rows pull their bundle (structure + tokens + dictionary +
// every page scan) and open in the manga reader; the 📚 library picker
// lists the PC's manga folder and queues volumes for the worker to OCR.
// Swipe-delete on a manga row is phone-local (the PC keeps pages, OCR and
// derived data for a reread); on a thread it purges the server too.
// Offline the list rebuilds from the shared jobs snapshot and downloaded
// items stay readable.

import { api, ApiError } from "../api";
import { cancelTapSync } from "../livesync";
import {
  deleteMangaFiles,
  downloadManga,
  getMangaPage,
  getMangaRecord,
  isComplete,
} from "../manga";
import { deletePageFiles, getPageRecord, isPageSource } from "../pages";
import { finishedEpisodes, groupSeries, isDone } from "../series";
import type { SeriesGroup } from "../series";
import {
  cacheJobs,
  clearSubmitted,
  clearTaps,
  getCachedJobs,
  getViewLog,
  hasPendingActions,
  pendingEnqueues,
  pendingWatched,
  queueEnqueue,
  removeEpisodeActions,
} from "../store";
import { swipeable } from "./queue";
import type { Job, JobState, MangaLibrary, MangaLibrarySeries } from "../types";

const STAGE1: JobState[] = ["downloading", "transcribing", "tokenizing"];
const ACTIVE: JobState[] = ["queued", ...STAGE1];
const READABLE: JobState[] = ["prepared", "curating", "staged", "reconciled", "watched"];

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function pageRow(job: Job, rerender: () => void, offline: boolean): HTMLElement {
  const row = el("div", "job");
  const main = el("div", "job-main");
  main.appendChild(el("div", "job-title", job.title || job.source || job.episode_id));
  const sub = el("div", "job-sub");
  // a queued-offline "finished reading" overlays the stale snapshot state
  const state = pendingWatched(job.episode_id) && job.state !== "watched" ? "watched" : job.state;
  sub.appendChild(el("span", `chip st-${state}`, state === "watched" ? "read" : state));
  if (hasPendingActions(job.episode_id)) sub.appendChild(el("span", "chip pending", "⇪ pending sync"));
  const rec = getPageRecord(job.episode_id);
  if (rec?.postCount) sub.appendChild(el("span", "muted", ` ${rec.postCount} posts`));
  if (job.comprehensibility != null)
    sub.appendChild(el("span", "muted", ` · ${Math.round(job.comprehensibility * 100)}% comp`));
  if (STAGE1.includes(job.state) && job.progress_msg)
    sub.appendChild(el("span", "muted", ` · ${job.progress_msg}`));
  if (job.error) sub.appendChild(el("span", "err", ` ${job.error.slice(0, 120)}`));
  main.appendChild(sub);
  row.appendChild(main);

  const actions = el("div", "job-actions");
  if (!offline && job.state === "failed") actions.appendChild(retryButton(job, rerender));
  if (READABLE.includes(job.state) && (rec || !offline)) {
    const open = el("a", "small btn", "📖 read") as HTMLAnchorElement;
    open.href = `#/page/${encodeURIComponent(job.episode_id)}`;
    actions.appendChild(open);
  }
  row.appendChild(actions);
  return row;
}

function retryButton(job: Job, rerender: () => void): HTMLButtonElement {
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
  return retry;
}

/** ⬇ button that pulls a volume's bundle, narrating pages landed. */
function downloadButton(job: Job, rerender: () => void, label = "⬇"): HTMLButtonElement {
  const dl = el("button", "small", label) as HTMLButtonElement;
  dl.addEventListener("click", async (e) => {
    e.stopPropagation();
    dl.disabled = true;
    try {
      await downloadManga(job.episode_id, (done, total) => {
        dl.textContent = `⬇ ${done}/${total}`;
      });
      rerender();
    } catch (err) {
      dl.textContent = label;
      dl.disabled = false;
      alert(`download failed: ${(err as Error).message}`);
    }
  });
  return dl;
}

export function volumeRow(job: Job, rerender: () => void, offline: boolean): HTMLElement {
  const row = el("div", "job");
  const main = el("div", "job-main");
  const title = el("div", "job-title");
  title.appendChild(el("span", "chip ep", `Vol ${String(job.ep_no ?? 0).padStart(2, "0")}`));
  title.appendChild(document.createTextNode(job.title || job.episode_id));
  main.appendChild(title);
  const sub = el("div", "job-sub");
  const state = pendingWatched(job.episode_id) && job.state !== "watched" ? "watched" : job.state;
  sub.appendChild(el("span", `chip st-${state}`, state === "watched" ? "read" : state));
  if (hasPendingActions(job.episode_id)) sub.appendChild(el("span", "chip pending", "⇪ pending sync"));
  const rec = getMangaRecord(job.episode_id);
  if (rec) {
    const at = getMangaPage(job.episode_id);
    sub.appendChild(
      el("span", "muted",
        isComplete(rec)
          ? ` ${rec.pageCount} pages on phone${at != null ? ` · at p.${at + 1}` : ""}`
          : ` ${rec.pagesDownloaded}/${rec.pageCount} pages`),
    );
  }
  if (job.comprehensibility != null)
    sub.appendChild(el("span", "muted", ` · ${Math.round(job.comprehensibility * 100)}% comp`));
  if (STAGE1.includes(job.state) && job.progress_msg)
    sub.appendChild(el("span", "muted", ` · ${job.progress_msg}`));
  if (job.error) sub.appendChild(el("span", "err", ` ${job.error.slice(0, 120)}`));
  main.appendChild(sub);
  row.appendChild(main);

  const actions = el("div", "job-actions");
  if (!offline && job.state === "failed") actions.appendChild(retryButton(job, rerender));
  if (READABLE.includes(job.state)) {
    if (isComplete(rec)) {
      const open = el("a", "small btn", "📖 read") as HTMLAnchorElement;
      open.href = `#/manga/${encodeURIComponent(job.episode_id)}`;
      actions.appendChild(open);
    } else if (!offline) {
      actions.appendChild(downloadButton(job, rerender, rec ? "⬇ resume" : "⬇"));
    }
  }
  row.appendChild(actions);
  return row;
}

/** One manga on the Read tab: header (title · n/N read · m on phone · next
    volume to read/pull) over its volumes in order. */
export function mangaBlock(
  g: SeriesGroup,
  rerender: () => void,
  offline: boolean,
  finished?: ReadonlySet<string>,
): HTMLElement {
  const block = el("div", "series");
  const key = `fp.manga.collapsed.${g.slug}`;
  if (localStorage.getItem(key) === "1") block.classList.add("collapsed");
  const head = el("div", "series-head");
  const caret = el("span", "muted", block.classList.contains("collapsed") ? "▸" : "▾");
  head.append(caret, el("span", "series-title", g.title));
  const done = g.episodes.filter((j) => isDone(j, finished)).length;
  const onPhone = g.episodes.filter((j) => isComplete(getMangaRecord(j.episode_id))).length;
  head.appendChild(el("span", "muted", `${done}/${g.episodes.length} read · ${onPhone} on phone`));
  head.addEventListener("click", () => {
    const collapsed = block.classList.toggle("collapsed");
    caret.textContent = collapsed ? "▸" : "▾";
    localStorage.setItem(key, collapsed ? "1" : "0");
  });
  const next = g.episodes.find((j) => !isDone(j, finished) && READABLE.includes(j.state));
  if (next) {
    const label = `Vol ${next.ep_no ?? "?"}`;
    if (isComplete(getMangaRecord(next.episode_id))) {
      const open = el("a", "small btn", `📖 ${label}`) as HTMLAnchorElement;
      open.href = `#/manga/${encodeURIComponent(next.episode_id)}`;
      open.addEventListener("click", (e) => e.stopPropagation());
      head.appendChild(open);
    } else if (!offline) {
      head.appendChild(downloadButton(next, rerender, `⬇ ${label}`));
    }
  }
  block.appendChild(head);
  const body = el("div", "series-body");
  for (const j of g.episodes)
    body.appendChild(
      swipeable(volumeRow(j, rerender, offline), () => void removeVolume(j, rerender)),
    );
  block.appendChild(body);
  return block;
}

/** Phone-local: drop the bundle (pages included) and pending marks. The
    server refuses DELETE on series-style rows anyway — the PC keeps the
    volume for a reread; the ledger keeps every mark and exposure. */
async function removeVolume(job: Job, reload: () => void): Promise<void> {
  const name = job.title || job.episode_id;
  if (!confirm(`Remove "${name}" from the phone?\n\nFrees the pages here; the PC keeps the volume and your marks/exposures stay in the ledger.`))
    return;
  const ep = job.episode_id;
  await deleteMangaFiles(ep).catch(() => {});
  cancelTapSync(ep);
  clearTaps(ep);
  clearSubmitted(ep);
  removeEpisodeActions(ep);
  reload();
}

/** Delete everywhere, pages flavor: server artifacts + queue row first, then
    the local bundle and pending actions. Ledger evidence from a read page
    survives server-side (purge keeps watched episodes' evidence). */
async function removePage(job: Job, reload: () => void, offline: boolean): Promise<void> {
  if (offline) {
    alert("Offline — deleting removes server artifacts, so it needs the server reachable.");
    return;
  }
  if (STAGE1.includes(job.state)) {
    alert(`Still ${job.state} — let it finish or fail first, then delete.`);
    return;
  }
  const name = job.title || job.source || job.episode_id;
  const read = job.state === "watched" || pendingWatched(job.episode_id);
  const msg = read
    ? `Delete "${name}"?\n\nRead ✔ — your marks and exposures are kept in the ledger. This clears the thread's files. Safe.`
    : `Delete "${name}"?\n\nNot marked read — its unread exposures will be unwound. Submitted known/interest marks are kept as evidence.`;
  if (!confirm(msg)) return;
  try {
    await api.deleteJob(job.episode_id);
  } catch (e) {
    alert(`delete failed: ${(e as Error).message}`);
    return;
  }
  const ep = job.episode_id;
  await deletePageFiles(ep).catch(() => {});
  cancelTapSync(ep); // a debounce still running must not re-freeze the taps
  clearTaps(ep);
  clearSubmitted(ep);
  removeEpisodeActions(ep);
  reload();
}

// --- the PC library picker --------------------------------------------------------

/** The PC's manga folder as an expandable list: tap a volume to queue it
    (or the whole series). Queue state per volume comes back with the
    listing, so what's already in the pipeline shows as such. */
function libraryPanel(onQueued: () => void): HTMLElement {
  const panel = el("div", "mg-library");
  const head = el("div", "toolbar");
  const title = el("span", "series-title", "📚 PC library");
  const refresh = el("button", "small", "↻") as HTMLButtonElement;
  const close = el("button", "small", "✕") as HTMLButtonElement;
  head.append(title, refresh, close);
  const status = el("div", "status", "listing the PC…");
  const list = el("div", "joblist");
  panel.append(head, status, list);
  close.addEventListener("click", () => panel.remove());

  const queueVolumes = async (s: MangaLibrarySeries, vols: number[], btn: HTMLButtonElement) => {
    btn.disabled = true;
    try {
      const r = await api.ingestManga(s.remote_dir, vols);
      status.textContent = `queued ${r.enqueued.length} volume(s) of ${r.title}`;
      onQueued();
      await load(true);
    } catch (e) {
      alert(`queue failed: ${(e as Error).message}`);
      btn.disabled = false;
    }
  };

  const render = (lib: MangaLibrary) => {
    list.textContent = "";
    status.textContent = `${lib.series.length} series under ${lib.root}`;
    for (const s of lib.series) {
      const block = el("div", "series collapsed");
      const h = el("div", "series-head");
      const caret = el("span", "muted", "▸");
      const queued = s.volumes.filter((v) => v.state).length;
      h.append(caret, el("span", "series-title", s.name),
        el("span", "muted", `${s.volumes.length} vol${queued ? ` · ${queued} queued` : ""}`));
      const all = el("button", "small", "queue all") as HTMLButtonElement;
      all.addEventListener("click", (e) => {
        e.stopPropagation();
        const vols = s.volumes.filter((v) => !v.state).map((v) => v.vol_no);
        if (!vols.length) return;
        if (!confirm(`Queue ${vols.length} volume(s) of ${s.name}? Each is OCR'd on the PC (a few minutes per volume).`)) return;
        void queueVolumes(s, vols, all);
      });
      h.appendChild(all);
      h.addEventListener("click", () => {
        const c = block.classList.toggle("collapsed");
        caret.textContent = c ? "▸" : "▾";
      });
      block.appendChild(h);
      const body = el("div", "series-body");
      for (const v of s.volumes) {
        const row = el("div", "job");
        const main = el("div", "job-main");
        main.appendChild(el("div", "job-title", `Vol ${v.vol_no} — ${v.label}`));
        const sub = el("div", "job-sub");
        sub.appendChild(el("span", "muted", `${v.pages} pages`));
        if (v.state) sub.appendChild(el("span", `chip st-${v.state}`, v.state === "watched" ? "read" : v.state));
        main.appendChild(sub);
        row.appendChild(main);
        const actions = el("div", "job-actions");
        if (!v.state) {
          const q = el("button", "small", "＋ queue") as HTMLButtonElement;
          q.addEventListener("click", () => void queueVolumes(s, [v.vol_no], q));
          actions.appendChild(q);
        }
        row.appendChild(actions);
        body.appendChild(row);
      }
      block.appendChild(body);
      list.appendChild(block);
    }
  };

  async function load(refreshList = false): Promise<void> {
    refresh.disabled = true;
    try {
      render(await api.getMangaLibrary(refreshList));
    } catch (e) {
      status.textContent = `⚠ ${(e as Error).message}`;
    } finally {
      refresh.disabled = false;
    }
  }
  refresh.addEventListener("click", () => void load(true));
  void load();
  return panel;
}

// --- the tab ------------------------------------------------------------------------

export function pagesView(): HTMLElement {
  const root = el("div", "view");

  const form = el("form", "enqueue") as HTMLFormElement;
  const input = el("input") as HTMLInputElement;
  input.type = "url";
  input.placeholder = "paste a 5ch thread URL";
  const add = el("button", "primary", "Queue") as HTMLButtonElement;
  add.type = "submit";
  form.append(input, add);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const source = input.value.trim();
    if (!source) return;
    if (!isPageSource(source)) {
      alert("Only 5ch thread URLs for now (itest.5ch.io/… or ….5ch.net/test/read.cgi/…).");
      return;
    }
    add.disabled = true;
    try {
      await api.enqueue(source);
      input.value = "";
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === undefined) {
        queueEnqueue(source); // park it — POST /jobs is idempotent by source
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

  const toolbar = el("div", "toolbar");
  const refresh = el("button", "small refresh", "↻ refresh") as HTMLButtonElement;
  refresh.addEventListener("click", () => void load());
  const libBtn = el("button", "small", "📚 PC library") as HTMLButtonElement;
  toolbar.append(refresh, libBtn);
  const status = el("div", "status");
  const libSlot = el("div");
  const list = el("div", "joblist");
  root.append(toolbar, status, libSlot, list);
  libBtn.addEventListener("click", () => {
    if (libSlot.firstChild) {
      libSlot.textContent = "";
      return;
    }
    libSlot.appendChild(libraryPanel(() => void load(true)));
  });

  let jobs: Job[] = [];
  let offline = false;
  let pollTimer: number | undefined;

  const pages = () => jobs.filter((j) => j.kind === "page");
  const manga = () => jobs.filter((j) => j.kind === "manga");

  function render(): void {
    list.textContent = "";
    const rerender = () => void load();
    for (const source of pendingEnqueues().filter(isPageSource)) {
      const row = el("div", "job");
      const main = el("div", "job-main");
      main.appendChild(el("div", "job-title", source));
      const sub = el("div", "job-sub");
      sub.appendChild(el("span", "chip pending", "⇪ will queue on sync"));
      main.appendChild(sub);
      row.appendChild(main);
      list.appendChild(row);
    }
    const vols = manga();
    const threads = pages();
    if (!offline) status.textContent = vols.length || threads.length ? "" : "nothing to read — queue a thread or pick from the PC library";
    if (vols.length) {
      list.appendChild(el("h2", "", "Manga"));
      const { standalone, series } = groupSeries(vols);
      // a volume this phone has already read through counts as read at once
      // (series.finishedEpisodes) — one pass over the view log, not per row
      const finished = finishedEpisodes(vols, getViewLog());
      for (const g of series) list.appendChild(mangaBlock(g, rerender, offline, finished));
      for (const j of standalone)
        list.appendChild(swipeable(volumeRow(j, rerender, offline), () => void removeVolume(j, rerender)));
    }
    if (threads.length) {
      if (vols.length) list.appendChild(el("h2", "", "5ch"));
      for (const j of threads)
        list.appendChild(
          swipeable(pageRow(j, rerender, offline), () => void removePage(j, rerender, offline)),
        );
    }
  }

  /** Page Stage 1 is seconds-fast and manga OCR narrates page by page —
      poll briskly while anything is active so the states tell the story. */
  function schedulePoll(): void {
    if (pollTimer) clearTimeout(pollTimer);
    if (offline || ![...pages(), ...manga()].some((j) => ACTIVE.includes(j.state))) return;
    pollTimer = window.setTimeout(() => {
      if (!root.isConnected) return;
      void load(true);
    }, 3000);
  }

  async function load(silent = false): Promise<void> {
    if (!silent) status.textContent = "loading…";
    try {
      jobs = await api.listJobs();
      offline = false;
      cacheJobs(jobs); // shared snapshot with the Queue tab
      render();
    } catch (e) {
      offline = true;
      const snap = getCachedJobs();
      jobs = snap?.jobs ?? [];
      const msg = e instanceof ApiError ? e.message : String(e);
      status.textContent = snap
        ? `⚠ offline — cached list from ${new Date(snap.at).toLocaleString()}`
        : `⚠ offline — ${msg}`;
      render();
    }
    schedulePoll();
  }

  void load();

  // a 5ch URL shared into the app lands here → enqueue it straight away
  const shared = sessionStorage.getItem("fp.pendingShare");
  if (shared && isPageSource(shared)) {
    sessionStorage.removeItem("fp.pendingShare");
    input.value = shared;
    form.requestSubmit(); // on failure the URL stays in the box for retry
  }

  return root;
}
