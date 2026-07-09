// Device-local state: settings, per-episode tap marks, the action outbox,
// the prep-doc cache, and the last queue snapshot. All in localStorage —
// persistent in the Capacitor webview, and small (the video is the only big
// artifact; it never goes here).
//
// Outbox semantics (MOBILE.md "Sync semantics"): every server write the app
// can make offline — tap batches, mark-watched, ratings, enqueues — is a
// typed action queued FIFO and flushed opportunistically. Each kind is
// replay-safe server-side (batch_id / review_id dedup, idempotent
// watched/enqueue), so a double-flush after a flaky connection is harmless.

import type { FollowState, Job, OutboxAction, PrepDoc, Stats, TapBatch, TapMark } from "./types";

export interface Settings {
  serverUrl: string;
  token: string;
}

const K = {
  settings: "fp.settings",
  taps: (ep: string) => `fp.taps.${ep}`,
  submitted: (ep: string) => `fp.submitted.${ep}`,
  outbox: "fp.outbox",
  prep: (ep: string) => `fp.prep.${ep}`,
  prepIndex: "fp.prepIndex",
  jobs: "fp.jobsCache",
  stats: "fp.statsCache",
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

// ---- settings ----------------------------------------------------------------

export function getSettings(): Settings {
  return read<Settings>(K.settings, { serverUrl: "", token: "" });
}

export function saveSettings(s: Settings): void {
  write(K.settings, s);
}

// ---- tap marks (live, per episode) --------------------------------------------

export function getTaps(episodeId: string): Record<string, TapMark> {
  return read(K.taps(episodeId), {});
}

export function cycleTap(episodeId: string, lemma: string): TapMark | undefined {
  const taps = getTaps(episodeId);
  if (taps[lemma] === "k") taps[lemma] = "h";
  else if (taps[lemma] === "h") delete taps[lemma];
  else taps[lemma] = "k";
  write(K.taps(episodeId), taps);
  return taps[lemma];
}

export function clearTaps(episodeId: string): void {
  localStorage.removeItem(K.taps(episodeId));
}

// ---- submitted baseline (what the last submit froze) --------------------------
// Kept so a reopened prep doc still shows the marks you sent, styled as
// "already submitted", instead of reverting to the un-marked original. It also
// lets the submit button count only *unsent* changes rather than every mark.

export function getSubmitted(episodeId: string): Record<string, TapMark> {
  return read(K.submitted(episodeId), {});
}

export function clearSubmitted(episodeId: string): void {
  localStorage.removeItem(K.submitted(episodeId));
}

/** Marks whose current value differs from what was last submitted — including
    marks cleared since submit. Zero once the current taps == the baseline. */
export function pendingTapCount(episodeId: string): number {
  const taps = getTaps(episodeId);
  const submitted = getSubmitted(episodeId);
  const lemmas = new Set([...Object.keys(taps), ...Object.keys(submitted)]);
  let n = 0;
  lemmas.forEach((l) => {
    if (taps[l] !== submitted[l]) n++;
  });
  return n;
}

// ---- outbox --------------------------------------------------------------------

function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The FIFO action queue. Pre-typed-outbox installs stored bare TapBatch[]
    here — migrate those entries in place on first read. */
export function getOutbox(): OutboxAction[] {
  const raw = read<(OutboxAction | TapBatch)[]>(K.outbox, []);
  if (!raw.some((a) => !("kind" in a))) return raw as OutboxAction[];
  const migrated = raw.map((a) =>
    "kind" in a ? a : ({ id: newId(), kind: "taps", batch: a } as OutboxAction),
  );
  write(K.outbox, migrated);
  return migrated;
}

function pushAction(action: OutboxAction): void {
  write(K.outbox, [...getOutbox(), action]);
}

/** The episode an action belongs to ("" for enqueues — no episode yet). */
export function actionEpisode(a: OutboxAction): string {
  return a.kind === "taps" ? a.batch.episode_id : a.kind === "enqueue" ? "" : a.episode_id;
}

/** Freeze the episode's current taps into the outbox. An empty batch is
    still meaningful feedback ("no corrections — default selection"). */
export function submitTaps(episodeId: string): TapBatch {
  const taps = getTaps(episodeId);
  const entries = Object.entries(taps) as [string, TapMark][];
  const batch: TapBatch = { episode_id: episodeId, batch_id: newId(), taps: entries };
  pushAction({ id: newId(), kind: "taps", batch });
  // Snapshot the sent marks as the new baseline, but DON'T clear the live taps:
  // they stay as the display source of truth so reopening the doc shows what you
  // submitted (styled "committed") instead of a blank, un-marked article.
  write(K.submitted(episodeId), { ...taps });
  return batch;
}

/** Queue a mark-watched for later flush (server unreachable at watch time).
    Replaces a pending one for the episode — the latest cards choice wins. */
export function queueWatched(episodeId: string, cards: boolean): void {
  write(
    K.outbox,
    getOutbox().filter((a) => !(a.kind === "watched" && a.episode_id === episodeId)),
  );
  pushAction({ id: newId(), kind: "watched", episode_id: episodeId, cards });
}

/** Queue a rating review. Replaces a pending unsent review for the episode —
    offline re-rates are UI fiddling, not taste drift; only the last one goes.
    The client-minted review_id makes the eventual POST replay-safe. */
export function queueRating(
  episodeId: string,
  rating: number | null,
  tags: string[],
  axes: Record<string, number> = {},
  follow: FollowState | null = null,
  note = "",
): void {
  write(
    K.outbox,
    getOutbox().filter((a) => !(a.kind === "rating" && a.episode_id === episodeId)),
  );
  pushAction({
    id: newId(),
    kind: "rating",
    episode_id: episodeId,
    rating,
    tags,
    axes,
    follow,
    note,
    review_id: newId(),
  });
}

/** Queue a passive shelve/un-shelve for later flush (server unreachable at
    watch time). Replaces a pending one for the episode — the latest flag wins.
    Enqueued after the watched action so FIFO lands it once the server has moved
    the row to `watched` (the /passive route 409s otherwise). */
export function queuePassive(episodeId: string, passive: boolean): void {
  write(
    K.outbox,
    getOutbox().filter((a) => !(a.kind === "passive" && a.episode_id === episodeId)),
  );
  pushAction({ id: newId(), kind: "passive", episode_id: episodeId, passive });
}

/** Queue a source for enqueueing (share-sheet/queue box while offline).
    POST /jobs is idempotent by source, so duplicates are dropped here too. */
export function queueEnqueue(source: string): void {
  if (getOutbox().some((a) => a.kind === "enqueue" && a.source === source)) return;
  pushAction({ id: newId(), kind: "enqueue", source });
}

export function removeFromOutbox(actionId: string): void {
  write(
    K.outbox,
    getOutbox().filter((a) => a.id !== actionId),
  );
}

/** Drop an episode's pending actions — a deleted episode must not flush. */
export function removeEpisodeActions(episodeId: string): void {
  write(
    K.outbox,
    getOutbox().filter((a) => actionEpisode(a) !== episodeId),
  );
}

// ---- pending-action reads (what the UI overlays while unsynced) ----------------

export function pendingWatched(episodeId: string): { cards: boolean } | null {
  const a = getOutbox().find((x) => x.kind === "watched" && x.episode_id === episodeId);
  return a && a.kind === "watched" ? { cards: a.cards } : null;
}

export function pendingPassive(episodeId: string): boolean | null {
  const a = getOutbox().find((x) => x.kind === "passive" && x.episode_id === episodeId);
  return a && a.kind === "passive" ? a.passive : null;
}

export function pendingRating(episodeId: string): {
  rating: number | null;
  tags: string[];
  axes: Record<string, number>;
  follow: FollowState | null;
  note: string;
} | null {
  const a = getOutbox().find((x) => x.kind === "rating" && x.episode_id === episodeId);
  return a && a.kind === "rating"
    ? { rating: a.rating, tags: a.tags, axes: a.axes, follow: a.follow, note: a.note }
    : null;
}

export function pendingEnqueues(): string[] {
  return getOutbox().flatMap((a) => (a.kind === "enqueue" ? [a.source] : []));
}

export function hasPendingActions(episodeId: string): boolean {
  return getOutbox().some((a) => actionEpisode(a) === episodeId);
}

/** Human summary for Settings: "2 tap batches · 1 watched · 1 rating". */
export function outboxSummary(): string {
  const counts = new Map<string, number>();
  for (const a of getOutbox()) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const label: Record<string, [string, string]> = {
    taps: ["tap batch", "tap batches"],
    watched: ["watched", "watched"],
    rating: ["rating", "ratings"],
    enqueue: ["enqueue", "enqueues"],
    passive: ["shelve", "shelves"],
  };
  return [...counts]
    .map(([k, n]) => `${n} ${label[k][n > 1 ? 1 : 0]}`)
    .join(" · ");
}

// ---- queue snapshot (offline queue screen) --------------------------------------

export function cacheJobs(jobs: Job[]): void {
  write(K.jobs, { at: new Date().toISOString(), jobs });
}

export function getCachedJobs(): { at: string; jobs: Job[] } | null {
  return read<{ at: string; jobs: Job[] } | null>(K.jobs, null);
}

// ---- stats snapshot (offline Progress screen) -----------------------------------

export function cacheStats(stats: Stats): void {
  write(K.stats, { at: new Date().toISOString(), stats });
}

export function getCachedStats(): { at: string; stats: Stats } | null {
  return read<{ at: string; stats: Stats } | null>(K.stats, null);
}

// ---- prep-doc cache -------------------------------------------------------------

export function cachePrep(doc: PrepDoc): void {
  write(K.prep(doc.episode.id), doc);
  const idx = read<string[]>(K.prepIndex, []);
  if (!idx.includes(doc.episode.id)) write(K.prepIndex, [...idx, doc.episode.id]);
}

export function getCachedPrep(episodeId: string): PrepDoc | null {
  return read<PrepDoc | null>(K.prep(episodeId), null);
}

export function cachedPrepIds(): string[] {
  return read<string[]>(K.prepIndex, []);
}

export function deleteCachedPrep(episodeId: string): void {
  localStorage.removeItem(K.prep(episodeId));
  write(
    K.prepIndex,
    cachedPrepIds().filter((id) => id !== episodeId),
  );
}
