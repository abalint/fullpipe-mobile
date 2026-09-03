// Pages tab: queue a 5ch thread URL, watch the worker prepare it (fetch →
// tokenize → staged, seconds not minutes), then read it in the in-app reader.
// Same throwaway lifecycle as episodes — swipe-delete when done reading; the
// known/high-interest marks and read exposures stay in the ledger. Offline
// the list rebuilds from the shared jobs snapshot and downloaded pages stay
// readable.

import { api, ApiError } from "../api";
import { deletePageFiles, getPageRecord, isPageSource } from "../pages";
import {
  cacheJobs,
  clearSubmitted,
  clearTaps,
  getCachedJobs,
  hasPendingActions,
  pendingEnqueues,
  pendingWatched,
  queueEnqueue,
  removeEpisodeActions,
} from "../store";
import { swipeable } from "./queue";
import type { Job, JobState } from "../types";

const STAGE1: JobState[] = ["downloading", "transcribing", "tokenizing"];
const ACTIVE: JobState[] = ["queued", ...STAGE1];
const READABLE: JobState[] = ["prepared", "staged", "reconciled", "watched"];

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
  if (READABLE.includes(job.state) && (rec || !offline)) {
    const open = el("a", "small btn", "📖 read") as HTMLAnchorElement;
    open.href = `#/page/${encodeURIComponent(job.episode_id)}`;
    actions.appendChild(open);
  }
  row.appendChild(actions);
  return row;
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
  clearTaps(ep);
  clearSubmitted(ep);
  removeEpisodeActions(ep);
  reload();
}

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
  toolbar.append(refresh);
  const status = el("div", "status");
  const list = el("div", "joblist");
  root.append(toolbar, status, list);

  let jobs: Job[] = [];
  let offline = false;
  let pollTimer: number | undefined;

  const pages = () => jobs.filter((j) => j.kind === "page");

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
    const rows = pages();
    if (!offline) status.textContent = rows.length ? "" : "no pages queued";
    for (const j of rows)
      list.appendChild(
        swipeable(pageRow(j, rerender, offline), () => void removePage(j, rerender, offline)),
      );
  }

  /** Page Stage 1 is seconds-fast — poll briskly while anything is active so
      "queued → staged" narrates itself without a manual refresh. */
  function schedulePoll(): void {
    if (pollTimer) clearTimeout(pollTimer);
    if (offline || !pages().some((j) => ACTIVE.includes(j.state))) return;
    pollTimer = window.setTimeout(() => {
      if (!root.isConnected) return;
      void load(true);
    }, 2000);
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
