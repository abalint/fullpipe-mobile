import { describe, expect, it } from "vitest";
import { epLabel, finishedEpisodes, groupSeries, isDone, nextEpisode, nextToWatch } from "./series";
import type { Job, ViewSegment } from "./types";
// @ts-ignore — node types aren't in this tsconfig; the test runs under node anyway
import { readFileSync } from "node:fs";

const job = (episode_id: string, extra: Partial<Job> = {}): Job =>
  ({ episode_id, source: "s", state: "staged", ...extra }) as Job;
const ep = (n: number, extra: Partial<Job> = {}) =>
  job(`ser_hotspot_e0${n}`, { series: "hotspot", series_title: "Hot Spot", ep_no: n, ...extra });

describe("groupSeries", () => {
  it("splits standalone rows from series and orders episodes by ep_no", () => {
    const jobs = [ep(3), job("yt_a"), ep(1), ep(2, { state: "watched" }),
      job("ser_other_e01", { series: "other", series_title: "Aardvark", ep_no: 1 })];
    const { standalone, series } = groupSeries(jobs);
    expect(standalone.map((j) => j.episode_id)).toEqual(["yt_a"]);
    expect(series.map((g) => g.title)).toEqual(["Aardvark", "Hot Spot"]);
    expect(series[1].episodes.map((j) => j.ep_no)).toEqual([1, 2, 3]);
  });
  it("falls back to the slug when no title rides along", () => {
    expect(groupSeries([job("x", { series: "s", ep_no: 1 })]).series[0].title).toBe("s");
  });
});

describe("nextEpisode / nextToWatch", () => {
  const jobs = [ep(2), ep(1, { state: "watched" }), ep(3), job("yt_a")];
  it("follows playlist order regardless of list order", () => {
    expect(nextEpisode(jobs, "ser_hotspot_e01")?.ep_no).toBe(2);
    expect(nextEpisode(jobs, "ser_hotspot_e03")).toBeNull();
    expect(nextEpisode(jobs, "yt_a")).toBeNull();
    expect(nextEpisode(jobs, "nope")).toBeNull();
  });
  it("resumes at the first unwatched episode", () => {
    const g = groupSeries(jobs).series[0];
    expect(nextToWatch(g)?.ep_no).toBe(2);
    expect(nextToWatch({ ...g, episodes: g.episodes.map((j) => ({ ...j, state: "watched" })) }))
      .toBeNull();
  });
});

describe("finishedEpisodes (the phone's own watched evidence)", () => {
  const seg = (extra: Partial<ViewSegment> = {}): ViewSegment =>
    ({
      id: `v${Math.random()}`, episode_id: "ser_hotspot_e01", title: "EP01", kind: "watch",
      day: "2026-09-20", start: "2026-09-20T20:00:00Z", secs: 0, reached: 0, duration: 1000,
      ...extra,
    }) as ViewSegment;

  it("counts an episode played past 80 % of its length", () => {
    expect([...finishedEpisodes([], [seg({ secs: 800 })])]).toEqual(["ser_hotspot_e01"]);
  });
  it("takes the length off the job when the sitting carries none", () => {
    const jobs = [ep(1, { duration: 600 })];
    expect(finishedEpisodes(jobs, [seg({ secs: 500, duration: null })]).size).toBe(1);
    // …and with no length on record anywhere, 500 s is short of the
    // unknown-duration bar, so it stays unfinished
    expect(finishedEpisodes([], [seg({ secs: 500, duration: null })]).size).toBe(0);
  });
  it("sums the sittings of one episode", () => {
    expect(finishedEpisodes([], [seg({ secs: 500 }), seg({ secs: 350 })]).size).toBe(1);
  });
  it("leaves a short partial play alone", () => {
    expect(finishedEpisodes([], [seg({ secs: 300 })]).size).toBe(0);
  });
  it("never counts passive listening", () => {
    expect(finishedEpisodes([], [seg({ secs: 1000, kind: "listen" })]).size).toBe(0);
  });
  it("counts the manga reader's sittings (kind read), like the server", () => {
    expect(finishedEpisodes([], [seg({ secs: 1000, kind: "read" })]).size).toBe(1);
  });
  it("ignores hand-typed and imported time — not this app's playback", () => {
    expect(finishedEpisodes([], [seg({ secs: 1000, source: "manual" })]).size).toBe(0);
    expect(finishedEpisodes([], [seg({ secs: 1000, source: "import" })]).size).toBe(0);
  });
  it("with no length anywhere, a long sitting still counts as a play", () => {
    expect(finishedEpisodes([], [seg({ secs: 700, duration: null })]).size).toBe(1);
    expect(finishedEpisodes([], [seg({ secs: 300, duration: null })]).size).toBe(0);
  });
});

describe("isDone / nextToWatch with local evidence", () => {
  const finished = new Set(["ser_hotspot_e02"]);
  it("counts a locally finished episode as done", () => {
    expect(isDone(ep(2), finished)).toBe(true);
    expect(isDone(ep(2))).toBe(false); // server-only view: still lagging
    expect(isDone(ep(3), finished)).toBe(false);
  });
  it("still honours the server's own states", () => {
    expect(isDone(ep(1, { state: "watched" }))).toBe(true);
    expect(isDone(ep(1, { state: "pushing" }))).toBe(true);
  });
  it("skips a locally finished episode when resuming the series", () => {
    const g = groupSeries([ep(1, { state: "watched" }), ep(2), ep(3)]).series[0];
    expect(nextToWatch(g)?.ep_no).toBe(2); // server alone: one episode behind
    expect(nextToWatch(g, finished)?.ep_no).toBe(3);
  });
});

describe("epLabel", () => {
  it("renders plain and season-folded numbers", () => {
    expect(epLabel(ep(3))).toBe("EP03");
    expect(epLabel(ep(203))).toBe("S2E03");
  });
});

describe("up-next overlay stays out of the way until an episode ends", () => {
  it("is display:none while hidden (regression: it dimmed every video and blocked subtitle taps)", () => {
    // vitest returns "" for css imports, so read the stylesheet off disk
    const css = readFileSync("src/style.css", "utf8"); // vitest cwd = repo root
    expect(css).toMatch(/\.upnext\[hidden\]\s*\{\s*display:\s*none/);
  });
});
