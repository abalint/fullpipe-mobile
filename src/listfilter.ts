// Sort + filter for the episode lists (Queue and Listen tabs): the pure
// ordering/narrowing functions, and the small toolbar of selects that drives
// them. Choices persist per tab in localStorage so the list comes back the
// way you left it.

import { getVideoRecord } from "./video";
import type { Job, JobState } from "./types";

export type QueueSort =
  | "newest"
  | "oldest"
  | "comp-desc"
  | "comp-asc"
  | "longest"
  | "shortest"
  | "rating"
  | "title";
export const SORT_OPTIONS: [QueueSort, string][] = [
  ["newest", "newest first"],
  ["oldest", "oldest first"],
  ["comp-desc", "easiest first"],
  ["comp-asc", "hardest first"],
  ["longest", "longest first"],
  ["shortest", "shortest first"],
  ["rating", "top rated first"],
  ["title", "title A→Z"],
];

/** Sort for the queue list. Metric sorts put rows without the metric (no
    coverage/duration/rating yet) at the bottom; ties fall back to newest. */
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
  const name = (j: Job) => j.title || j.source || j.episode_id;
  const cmp = {
    newest,
    oldest: (a: Job, b: Job) => -newest(a, b),
    "comp-desc": metric((j) => j.comprehensibility, true),
    "comp-asc": metric((j) => j.comprehensibility, false),
    longest: metric((j) => j.duration, true),
    shortest: metric((j) => j.duration, false),
    rating: metric((j) => j.rating, true),
    title: (a: Job, b: Job) => name(a).localeCompare(name(b), "ja") || newest(a, b),
  }[sort];
  return [...jobs].sort(cmp);
}

/** Status buckets for the queue filter. "to watch" is curated-and-unwatched
    (what the backlog counts); "watched" includes the close-out still pushing
    cards; everything else is the pipeline still working (or failed). */
export type StatusFilter = "all" | "towatch" | "watched" | "working";
export const STATUS_OPTIONS: [StatusFilter, string][] = [
  ["all", "any status"],
  ["towatch", "to watch"],
  ["watched", "watched"],
  ["working", "in progress"],
];
const TO_WATCH: JobState[] = ["staged", "reconciled"];
const WATCHED: JobState[] = ["watched", "pushing"];

export interface ListFilter {
  status: StatusFilter;
  genre: string; // "" = any; a label = that genre only
  onPhone: boolean; // only episodes whose video is downloaded
}
export const NO_FILTER: ListFilter = { status: "all", genre: "", onPhone: false };

/** Genre labels present in a list, most common first (ties A→Z), so the
    picker only offers what's actually there. */
export function genresOf(jobs: Job[]): string[] {
  const counts = new Map<string, number>();
  for (const j of jobs) if (j.genre) counts.set(j.genre, (counts.get(j.genre) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([g]) => g);
}

export function filterJobs(
  jobs: Job[],
  f: ListFilter,
  hasVideo: (episodeId: string) => boolean = (id) => !!getVideoRecord(id),
): Job[] {
  return jobs.filter((j) => {
    if (f.status === "towatch" && !TO_WATCH.includes(j.state)) return false;
    if (f.status === "watched" && !WATCHED.includes(j.state)) return false;
    if (f.status === "working" && (TO_WATCH.includes(j.state) || WATCHED.includes(j.state)))
      return false;
    if (f.genre && j.genre !== f.genre) return false;
    if (f.onPhone && !hasVideo(j.episode_id)) return false;
    return true;
  });
}

export function isFiltered(f: ListFilter): boolean {
  return f.status !== "all" || !!f.genre || f.onPhone;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function select(cls: string, options: [string, string][]): HTMLSelectElement {
  const s = el("select", cls) as HTMLSelectElement;
  for (const [value, label] of options) {
    const o = el("option", "", label) as HTMLOptionElement;
    o.value = value;
    s.appendChild(o);
  }
  return s;
}

export interface ListControls {
  sort: HTMLSelectElement; // goes in the tab's main toolbar
  filters: HTMLElement; // the filter row (status · genre · on-phone · count)
  current: () => { sort: QueueSort; filter: ListFilter };
  /** Refresh the genre picker from the rows on screen and paint the
      "n of N" readout; call after every load/render. */
  update: (jobs: Job[], shown: number) => void;
}

/** The sort select + filter row for one episode list. `key` namespaces the
    persisted choices per tab; `status: false` drops the status select (the
    Listen tab is all watched). `onChange` re-renders the list. */
export function listControls(
  key: string,
  onChange: () => void,
  opts: { status?: boolean } = {},
): ListControls {
  const SORT_KEY = `${key}.sort`;
  const FILTER_KEY = `${key}.filter`;

  const sort = select("small sort", SORT_OPTIONS);
  const savedSort = localStorage.getItem(SORT_KEY) as QueueSort | null;
  sort.value = savedSort && SORT_OPTIONS.some(([v]) => v === savedSort) ? savedSort : "newest";
  sort.addEventListener("change", () => {
    localStorage.setItem(SORT_KEY, sort.value);
    onChange();
  });

  let filter: ListFilter = { ...NO_FILTER };
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "null");
    if (saved && typeof saved === "object") filter = { ...NO_FILTER, ...saved };
  } catch {
    /* corrupt → defaults */
  }
  if (opts.status === false || !STATUS_OPTIONS.some(([v]) => v === filter.status))
    filter.status = "all";
  const save = () => localStorage.setItem(FILTER_KEY, JSON.stringify(filter));

  const filters = el("div", "filters");
  let status: HTMLSelectElement | undefined;
  if (opts.status !== false) {
    status = select("small sort", STATUS_OPTIONS);
    status.value = filter.status;
    status.addEventListener("change", () => {
      filter.status = status!.value as StatusFilter;
      save();
      onChange();
    });
    filters.appendChild(status);
  }
  const genre = select("small sort", [["", "any genre"]]);
  genre.addEventListener("change", () => {
    filter.genre = genre.value;
    save();
    onChange();
  });
  const onPhone = el("button", `small toggle${filter.onPhone ? " on" : ""}`, "⬇ on phone") as HTMLButtonElement;
  onPhone.title = "only episodes downloaded to this phone";
  onPhone.addEventListener("click", () => {
    filter.onPhone = !filter.onPhone;
    onPhone.classList.toggle("on", filter.onPhone);
    save();
    onChange();
  });
  const count = el("span", "muted count");
  const clear = el("button", "small clear", "✕") as HTMLButtonElement;
  clear.title = "clear filters";
  clear.addEventListener("click", () => {
    filter = { ...NO_FILTER };
    if (status) status.value = "all";
    genre.value = "";
    onPhone.classList.remove("on");
    save();
    onChange();
  });
  filters.append(genre, onPhone, count, clear);

  const paintGenres = (jobs: Job[]) => {
    const have = genresOf(jobs);
    // keep a saved choice selectable even if nothing on screen carries it,
    // so the empty result is explicable (and clearable) rather than silent
    if (filter.genre && !have.includes(filter.genre)) have.push(filter.genre);
    genre.textContent = "";
    for (const [value, label] of [["", "any genre"], ...have.map((g) => [g, g])] as [string, string][]) {
      const o = el("option", "", label) as HTMLOptionElement;
      o.value = value;
      genre.appendChild(o);
    }
    genre.value = filter.genre;
    genre.disabled = have.length === 0;
  };

  return {
    sort,
    filters,
    current: () => ({ sort: sort.value as QueueSort, filter }),
    update: (jobs, shown) => {
      paintGenres(jobs);
      const active = isFiltered(filter);
      count.textContent = active ? `${shown} of ${jobs.length}` : "";
      clear.style.display = active ? "" : "none";
    },
  };
}
