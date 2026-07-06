// Thin client for the fullPipe sync server (MOBILE.md "Server API" table).
// Plain HTTP inside the tailnet; bearer token as belt-and-suspenders.

import type { Job, PrepDoc, TapBatch } from "./types";
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
  deleteJob: (id: string) =>
    request<{ deleted: string; files_removed: number }>(
      `/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getPrep: (id: string) => request<PrepDoc>(`/prep/${encodeURIComponent(id)}`),
  postTaps: (batch: TapBatch) =>
    request<{ applied: number; cards_selected?: number | null; duplicate: boolean }>(
      "/taps", { method: "POST", body: JSON.stringify(batch) }),
  // rating 1-5 (null clears) + optional taste tags — appended to the taste_events
  // log server-side (re-POST appends a new review; the on-read verdict takes the latest)
  rate: (id: string, rating: number | null, tags: string[] = []) =>
    request<{ episode_id: string; rating: number | null; tags: string[] }>(
      `/episodes/${encodeURIComponent(id)}/rating`,
      { method: "POST", body: JSON.stringify({ rating, tags }) }),
  // cards:false is the disliked-it branch — exposures still activate, deck stays clean
  markWatched: (id: string, cards = true) =>
    request<{ watched: boolean; cards?: { pushed: number; error?: string; deck?: string } }>(
      `/watched/${encodeURIComponent(id)}`,
      { method: "POST", body: JSON.stringify({ cards }) }),
  videoUrl: (id: string) => `${base()}/video/${encodeURIComponent(id)}`,
  subsUrl: (id: string) => `${base()}/video/${encodeURIComponent(id)}/subs`,
  fetchSubs: async (id: string): Promise<string> => {
    const { token } = getSettings();
    const res = await fetch(api.subsUrl(id), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(`subs: ${res.status}`, res.status);
    return res.text();
  },
};
