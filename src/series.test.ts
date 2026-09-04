import { describe, expect, it } from "vitest";
import { epLabel, groupSeries, nextEpisode, nextToWatch } from "./series";
import type { Job } from "./types";
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
