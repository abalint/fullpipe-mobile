// Series (box sets ingested on the PC by tools.series — MOBILE.md "Series").
// A series episode is an ordinary job that also carries `series` (slug),
// `series_title` and `ep_no` (playlist order). Pure helpers: the queue groups
// rows by series and orders them by ep_no, the player finds the next episode
// to autoplay, and delete becomes phone-local for these rows (the PC keeps
// the video and every derived artifact so the series can be rewatched).
// Done-ness (isDone / finishedEpisodes) lives here too: the server's state
// plus, since 2026-09-20, the phone's own view log, so the lists don't sit an
// episode behind what was just played.

import type { Job, ViewSegment } from "./types";

export interface SeriesGroup {
  slug: string;
  title: string;
  episodes: Job[]; // ascending ep_no
}

export function isSeries(j: Job): boolean {
  return !!j.series;
}

/** The finished bar, the server's own (ledgerctl PLAY_ACTIVATION_FRACTION):
    playing time over the episode's length. */
export const PLAY_DONE_FRACTION = 0.8;
// A sitting with no length to measure against counts as one whole play once
// it runs this long (ledgerctl _PLAY_UNKNOWN_DURATION_SECS).
const UNKNOWN_DURATION_SECS = 600;

/** Episodes this phone has itself played to the end (2026-09-20). The server
    only flips `watched` once the sitting has been POSTed *and* a fresh
    `GET /jobs` has come back, so a queue that trusts the server alone reads
    one episode behind what was just watched — the header count, the ▶ next
    button, the EP chips and the row state all lag. This is the phone's own
    evidence, from the local view log (store.getViewLog).

    The rule is exactly the server's (ledgerctl `episode_plays` +
    `activate_played_episodes`): sum the app's own `watch`/`read` sittings'
    playing seconds over the episode's length — the sitting's own `duration`,
    else the job's — and call it finished at PLAY_DONE_FRACTION. `listen`
    (the Listen tab) is passive exposure and never counts; hand-typed and
    imported sittings aren't this app's playback and are skipped the way the
    server's `source = 'app'` skips them.

    Deliberately *not* viewtime's `completion()` ("got within 10 s of the
    end"): nothing in the queue or series UI uses that notion today — it is
    the Progress tab's per-sitting readout — and a local rule the server does
    not share would paint rows watched that never actually flip. Display and
    navigation only: the server still owns the `watched` state itself. */
export function finishedEpisodes(jobs: Job[], log: ViewSegment[]): ReadonlySet<string> {
  const durations = new Map<string, number>();
  for (const j of jobs) if (j.duration) durations.set(j.episode_id, j.duration);
  const plays = new Map<string, number>(); // episode → plays (fraction of its length)
  for (const s of log) {
    if (s.kind === "listen") continue;
    if (s.source && s.source !== "app") continue;
    const dur = s.duration || durations.get(s.episode_id) || 0;
    const frac = dur > 0 ? s.secs / dur : s.secs >= UNKNOWN_DURATION_SECS ? 1 : 0;
    if (frac > 0) plays.set(s.episode_id, (plays.get(s.episode_id) ?? 0) + frac);
  }
  const done = new Set<string>();
  for (const [id, frac] of plays) if (frac >= PLAY_DONE_FRACTION) done.add(id);
  return done;
}

/** Playlist done-ness: watched, the close-out still pushing cards — or, when
    the caller passes `finished` (one `finishedEpisodes` set built per render,
    never per row), the phone's own view log says it was played to the end. */
export function isDone(j: Job, finished?: ReadonlySet<string>): boolean {
  return j.state === "watched" || j.state === "pushing" || !!finished?.has(j.episode_id);
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
    watched one counts), else null when the whole set is done. `finished`
    (finishedEpisodes) lets it skip an episode the phone has just played but
    the server hasn't been told about yet. */
export function nextToWatch(g: SeriesGroup, finished?: ReadonlySet<string>): Job | null {
  return g.episodes.find((j) => !isDone(j, finished)) ?? null;
}
