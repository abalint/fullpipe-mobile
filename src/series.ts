// Series (box sets ingested on the PC by tools.series — MOBILE.md "Series").
// A series episode is an ordinary job that also carries `series` (slug),
// `series_title` and `ep_no` (playlist order). Pure helpers: the queue groups
// rows by series and orders them by ep_no, the player finds the next episode
// to autoplay, and delete becomes phone-local for these rows (the PC keeps
// the video and every derived artifact so the series can be rewatched).

import type { Job } from "./types";

export interface SeriesGroup {
  slug: string;
  title: string;
  episodes: Job[]; // ascending ep_no
}

export function isSeries(j: Job): boolean {
  return !!j.series;
}

/** Playlist done-ness: watched, or the close-out still pushing cards. */
export function isDone(j: Job): boolean {
  return j.state === "watched" || j.state === "pushing";
}

/** "EP03" / "S2E03" from the playlist order (season folds in as hundreds). */
export function epLabel(j: Job): string {
  const n = j.ep_no ?? 0;
  if (n >= 100) return `S${Math.floor(n / 100)}E${String(n % 100).padStart(2, "0")}`;
  return `EP${String(n).padStart(2, "0")}`;
}

/** Split a job list into standalone rows and per-series groups (episodes in
    playlist order; groups in title order). */
export function groupSeries(jobs: Job[]): { standalone: Job[]; series: SeriesGroup[] } {
  const standalone: Job[] = [];
  const bySlug = new Map<string, SeriesGroup>();
  for (const j of jobs) {
    if (!j.series) {
      standalone.push(j);
      continue;
    }
    let g = bySlug.get(j.series);
    if (!g) {
      g = { slug: j.series, title: j.series_title || j.series, episodes: [] };
      bySlug.set(j.series, g);
    }
    g.episodes.push(j);
  }
  const series = [...bySlug.values()].map((g) => ({
    ...g,
    episodes: [...g.episodes].sort((a, b) => (a.ep_no ?? 0) - (b.ep_no ?? 0)),
  }));
  series.sort((a, b) => a.title.localeCompare(b.title, "ja"));
  return { standalone, series };
}

/** The episode after `episodeId` in its series, or null (last / not a series). */
export function nextEpisode(jobs: Job[], episodeId: string): Job | null {
  const cur = jobs.find((j) => j.episode_id === episodeId);
  if (!cur?.series) return null;
  const eps = groupSeries(jobs).series.find((g) => g.slug === cur.series)?.episodes ?? [];
  const i = eps.findIndex((j) => j.episode_id === episodeId);
  return i >= 0 && i + 1 < eps.length ? eps[i + 1] : null;
}

/** Where to pick the series up: the first episode not yet watched (a partly
    watched one counts), else null when the whole set is done. */
export function nextToWatch(g: SeriesGroup): Job | null {
  return g.episodes.find((j) => !isDone(j)) ?? null;
}
