// Device-local state: settings, per-episode tap marks, the tap outbox, and
// the prep-doc cache. All in localStorage — persistent in the Capacitor
// webview, and small (the video is the only big artifact; it never goes here).
//
// Outbox semantics (MOBILE.md "Sync semantics"): submitting taps freezes them
// into a TapBatch with a client-generated batch_id, so a re-flush after a
// reconnect replays idempotently — the server dedupes on batch_id.

import type { PrepDoc, TapBatch, TapMark } from "./types";

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

export function getOutbox(): TapBatch[] {
  return read<TapBatch[]>(K.outbox, []);
}

function newBatchId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Freeze the episode's current taps into the outbox. An empty batch is
    still meaningful feedback ("no corrections — default selection"). */
export function submitTaps(episodeId: string): TapBatch {
  const taps = getTaps(episodeId);
  const entries = Object.entries(taps) as [string, TapMark][];
  const batch: TapBatch = { episode_id: episodeId, batch_id: newBatchId(), taps: entries };
  write(K.outbox, [...getOutbox(), batch]);
  // Snapshot the sent marks as the new baseline, but DON'T clear the live taps:
  // they stay as the display source of truth so reopening the doc shows what you
  // submitted (styled "committed") instead of a blank, un-marked article.
  write(K.submitted(episodeId), { ...taps });
  return batch;
}

export function removeFromOutbox(batchId: string): void {
  write(
    K.outbox,
    getOutbox().filter((b) => b.batch_id !== batchId),
  );
}

/** Drop an episode's pending batches — a deleted episode must not flush. */
export function removeEpisodeBatches(episodeId: string): void {
  write(
    K.outbox,
    getOutbox().filter((b) => b.episode_id !== episodeId),
  );
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
