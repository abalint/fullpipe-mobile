// Thin client for the fullPipe sync server (MOBILE.md "Server API" table).
// Plain HTTP inside the tailnet; bearer token as belt-and-suspenders.

import type { Definitions, Job, PrepDoc, TapBatch, TranscriptDoc } from "./types";
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { token } = getSettings();
  const headers: Record<string, string> = {
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  let res: Response;
  try {
    res = await fetch(base() + path, { ...init, headers });
  } catch (e) {
    throw new ApiError(`Server unreachable (${(e as Error).message})`);
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
  // media/artifact URLs carry the token as ?t= too: <video src> and
  // Filesystem.downloadFile can't always send headers (server media_auth
  // accepts either; tailnet-only traffic, so a query token is fine)
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
    const res = await fetch(api.subsUrl(id), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(`subs: ${res.status}`, res.status);
    return res.text();
  },
};
