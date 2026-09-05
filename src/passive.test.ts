// Listen tab offline: with the server unreachable the view must rebuild its
// rows from the shared job snapshot (fp.jobsCache) — passive listening is
// the away-from-home feature, so an empty list here is a real regression.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./audio", () => ({
  PassiveAudio: {
    getState: () => Promise.resolve({ running: false, playing: false, index: -1 }),
    getLastEpisode: () => Promise.resolve({}),
    addListener: () => Promise.resolve({ remove: () => {} }),
  },
  buildPlaylist: () => Promise.resolve([]),
  resolveStartIndex: () => 0,
}));

import { api, ApiError } from "./api";
import { cacheJobs, saveSettings } from "./store";
import { passiveView } from "./views/passive";
import type { Job } from "./types";

const jobs: Job[] = [
  { episode_id: "yt_a", source: "u", title: "ラジオドラマ A", state: "watched", passive: true },
  { episode_id: "yt_b", source: "u", title: "not passive", state: "watched" },
];

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("passiveView offline", () => {
  beforeEach(() => {
    localStorage.clear();
    saveSettings({ serverUrl: "http://100.64.0.1:8321", token: "" });
  });

  it("lists the cached passive episodes when the server is unreachable", async () => {
    cacheJobs(jobs);
    vi.spyOn(api, "listJobs").mockRejectedValue(new ApiError("Server unreachable (timed out)"));
    const root = passiveView();
    document.body.appendChild(root);
    await settle();
    const titles = [...root.querySelectorAll(".job-title")].map((n) => n.textContent);
    expect(titles).toEqual(["ラジオドラマ A"]);
    expect(root.querySelector(".status")!.textContent).toContain("offline");
    root.remove();
  });

  it("paints the snapshot before the server probe settles", async () => {
    cacheJobs(jobs);
    // a request that never returns — an unreachable host looks like this
    // until the fetch deadline; the rows must not wait for it
    vi.spyOn(api, "listJobs").mockReturnValue(new Promise(() => {}));
    const root = passiveView();
    document.body.appendChild(root);
    await settle();
    const titles = [...root.querySelectorAll(".job-title")].map((n) => n.textContent);
    expect(titles).toEqual(["ラジオドラマ A"]);
    expect(root.querySelector(".status")!.textContent).toContain("loading… · cached list");
    expect(root.querySelector(".job-actions")!.textContent).not.toContain("↩ queue");
    root.remove();
  });

  it("says so when there is no snapshot at all", async () => {
    vi.spyOn(api, "listJobs").mockRejectedValue(new ApiError("Server unreachable"));
    const root = passiveView();
    document.body.appendChild(root);
    await settle();
    expect(root.querySelectorAll(".job-title").length).toBe(0);
    expect(root.querySelector(".status")!.textContent).toContain("no cached list");
    root.remove();
  });
});
