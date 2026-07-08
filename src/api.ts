// Thin client for the fullPipe sync server (MOBILE.md "Server API" table).
// Plain HTTP inside the tailnet; bearer token as belt-and-suspenders.

import type {
  ConfirmCandidate,
  Definitions,
  ItemKind,
  Job,
  PrepDoc,
  Stats,
  TapBatch,
  TranscriptDoc,
} from "./types";
import { getSettings } from "./store";

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

function base(): string {
  const url = getSettings().serverUrl.trim().replace(/\/+$/, "");
  if (!url) throw new ApiError("No server URL configured — set it in Settings");
  return url;
}

function withToken(url: string): string {
  const { token } = getSettings();
  return token ? `${url}?t=${encodeURIComponent(token)}` : url;
}

// Every JSON call gets a hard deadline. The server lives on the tailnet and
// answers in well under a second when it's up (the slow work — curation, card
// push, clip cutting — all runs off the request thread server-side), so if a
// call hasn't returned in a few seconds the host is off or unreachable. Without
// this, a dead server means fetch hangs on the OS connect timeout (30–120s on
// Android) and the queue screen sits behind "loading…" the whole time.
// Video downloads don't come through here (they go via Capacitor Filesystem in
// video.ts), so they're never cut off by this deadline.
const REQUEST_TIMEOUT_MS = 6000;

/** fetch() with a timeout. Aborts the request after `ms`; the abort surfaces as
    a network throw (no HTTP status), which callers treat as "unreachable". */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { token } = getSettings();
  const headers: Record<string, string> = {
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  let res: Response;
  try {
    res = await fetchWithTimeout(base() + path, { ...init, headers }, REQUEST_TIMEOUT_MS);
  } catch (e) {
    const msg = (e as Error).name === "AbortError"
      ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : (e as Error).message;
    throw new ApiError(`Server unreachable (${msg})`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`, res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean }>("/health"),
  listJobs: () => request<Job[]>("/jobs"),
  getJob: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}`),
  enqueue: (source: string) =>
    request<Job>("/jobs", { method: "POST", body: JSON.stringify({ source }) }),
  curate: (id: string) =>
    request<Job>(`/jobs/${encodeURIComponent(id)}/curate`, { method: "POST" }),
  // re-queue a failed Stage-1 job (the Retry button); the worker picks it up
  retryJob: (id: string) =>
    request<Job>(`/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  // progress dashboard (known counts, freq-band coverage) for the Stats tab
  getStats: () => request<Stats>("/stats"),
  // the exposure-confirmation queue ("we think you know this — do you?")
  getConfirmQueue: () => request<{ candidates: ConfirmCandidate[] }>("/confirm"),
  // answer one: known:true promotes it, known:false snoozes it. The key is
  // typed (word lemma / phrase headword / grammar pattern) — GRAMMAR.md.
  confirmWord: (kind: ItemKind, key: string, known: boolean) =>
    request<{ kind: ItemKind; key: string; known: boolean; status: string | null }>(
      "/confirm", { method: "POST", body: JSON.stringify({ kind, key, known }) }),
  // shelve a watched episode into the passive-listening collection (or pull
  // it back out) — server-side flag only, artifacts stay put
  setPassive: (id: string, passive: boolean) =>
    request<Job>(`/jobs/${encodeURIComponent(id)}/passive`,
      { method: "POST", body: JSON.stringify({ passive }) }),
  deleteJob: (id: string) =>
    request<{ deleted: string; files_removed: number }>(
      `/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getPrep: (id: string) => request<PrepDoc>(`/prep/${encodeURIComponent(id)}`),
  postTaps: (batch: TapBatch) =>
    request<{ applied: number; cards_selected?: number | null; duplicate: boolean }>(
      "/taps", { method: "POST", body: JSON.stringify(batch) }),
  // rating 1-5 (null clears) + optional taste tags — appended to the taste_events
  // log server-side (re-POST appends a new review; the on-read verdict takes the
  // latest). review_id makes the POST replay-safe for outbox re-flushes.
  rate: (id: string, rating: number | null, tags: string[] = [], reviewId?: string) =>
    request<{ episode_id: string; rating: number | null; tags: string[] }>(
      `/episodes/${encodeURIComponent(id)}/rating`,
      { method: "POST", body: JSON.stringify({ rating, tags, review_id: reviewId }) }),
  // cards:false is the disliked-it branch — exposures still activate, deck stays clean.
  // The push itself runs server-side in the background: the response says how many
  // cards were queued; progress/errors land on the queue row (`pushing` → `watched`)
  markWatched: (id: string, cards = true) =>
    request<{
      watched: boolean;
      cards?: { queued?: number; note?: string; pushed?: number; error?: string; deck?: string };
    }>(`/watched/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ cards }) }),
  // media/artifact URLs carry the token as ?t= too: Filesystem.downloadFile
  // can't always send headers (server media_auth accepts either;
  // tailnet-only traffic, so a query token is fine)
  videoUrl: (id: string) => withToken(`${base()}/video/${encodeURIComponent(id)}`),
  subsUrl: (id: string) => withToken(`${base()}/video/${encodeURIComponent(id)}/subs`),
  transcriptUrl: (id: string) => `${base()}/transcript/${encodeURIComponent(id)}`,
  // full tokenized sentence track (every sentence, start/end + tokens) for the
  // in-app player's subtitle overlay — /prep only ships the i+1 subset
  getTranscript: (id: string) =>
    request<TranscriptDoc>(`/transcript/${encodeURIComponent(id)}`),
  definitionsUrl: (id: string) => `${base()}/definitions/${encodeURIComponent(id)}`,
  // JMdict entries for every content lemma in the episode (any-word popup);
  // {} until the PC has run `tools.jmdict build`
  getDefinitions: (id: string) =>
    request<Definitions>(`/definitions/${encodeURIComponent(id)}`),
  fetchSubs: async (id: string): Promise<string> => {
    const { token } = getSettings();
    let res: Response;
    try {
      res = await fetchWithTimeout(
        api.subsUrl(id),
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        REQUEST_TIMEOUT_MS,
      );
    } catch (e) {
      const msg = (e as Error).name === "AbortError"
        ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : (e as Error).message;
      throw new ApiError(`subs unreachable (${msg})`);
    }
    if (!res.ok) throw new ApiError(`subs: ${res.status}`, res.status);
    return res.text();
  },
};
