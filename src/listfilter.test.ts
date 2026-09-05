import { describe, expect, it } from "vitest";
import { filterJobs, genresOf, listControls, sortJobs } from "./listfilter";
import type { Job } from "./types";

const job = (episode_id: string, extra: Partial<Job> = {}): Job =>
  ({ episode_id, source: "s", state: "staged", ...extra }) as Job;
const ids = (jobs: Job[]) => jobs.map((j) => j.episode_id);

describe("sortJobs — rating and title", () => {
  const jobs = [
    job("a", { created_at: "2026-07-01", rating: 3, title: "さくら" }),
    job("b", { created_at: "2026-07-03", rating: 5, title: "Zoo" }),
    job("c", { created_at: "2026-07-02", title: "apple" }), // unrated
  ];
  it("puts the best-rated first and unrated last", () => {
    expect(ids(sortJobs(jobs, "rating"))).toEqual(["b", "a", "c"]);
  });
  it("orders by title", () => {
    expect(ids(sortJobs(jobs, "title"))).toEqual(["c", "b", "a"]);
  });
});

describe("filterJobs", () => {
  const jobs = [
    job("ready", { state: "staged", genre: "vlog" }),
    job("done", { state: "watched", genre: "documentary" }),
    job("pushing", { state: "pushing", genre: "documentary" }),
    job("work", { state: "transcribing" }),
    job("dead", { state: "failed", genre: "vlog" }),
    job("half", { state: "staged" }), // started, left at 4:00
  ];
  const onPhone = (id: string) => id === "done" || id === "ready";
  const positionOf = (id: string) => (id === "half" ? 240 : id === "done" ? 0 : null);

  it("passes everything through with no filter", () => {
    expect(ids(filterJobs(jobs, { status: "all", genre: "", onPhone: false }, onPhone)))
      .toEqual(ids(jobs));
  });
  it("buckets by status", () => {
    expect(ids(filterJobs(jobs, { status: "towatch", genre: "", onPhone: false }, onPhone)))
      .toEqual(["ready", "half"]);
    expect(ids(filterJobs(jobs, { status: "watched", genre: "", onPhone: false }, onPhone)))
      .toEqual(["done", "pushing"]);
    expect(ids(filterJobs(jobs, { status: "working", genre: "", onPhone: false }, onPhone)))
      .toEqual(["work", "dead"]);
  });
  it('"in progress" is a saved playback position, not a pipeline state', () => {
    // a position of 0 (never really started) or none at all is not in progress
    expect(ids(filterJobs(jobs, { status: "partway", genre: "", onPhone: false }, onPhone, positionOf)))
      .toEqual(["half"]);
    // the default lookup reads the player's saved position
    localStorage.setItem("fp.pos.ready", "12.5");
    try {
      expect(ids(filterJobs(jobs, { status: "partway", genre: "", onPhone: false }, onPhone)))
        .toEqual(["ready"]);
    } finally {
      localStorage.removeItem("fp.pos.ready");
    }
  });
  it("narrows by genre and by what is downloaded, together", () => {
    expect(ids(filterJobs(jobs, { status: "all", genre: "vlog", onPhone: false }, onPhone)))
      .toEqual(["ready", "dead"]);
    expect(ids(filterJobs(jobs, { status: "all", genre: "vlog", onPhone: true }, onPhone)))
      .toEqual(["ready"]);
    expect(ids(filterJobs(jobs, { status: "all", genre: "", onPhone: true }, onPhone)))
      .toEqual(["ready", "done"]);
  });
  it("lists the genres present, most common first", () => {
    expect(genresOf(jobs)).toEqual(["documentary", "vlog"]);
    expect(genresOf([job("x")])).toEqual([]);
  });
});

describe("listControls", () => {
  it("persists sort and filter choices under the tab's key", () => {
    localStorage.clear();
    let changes = 0;
    const c = listControls("fp.t", () => changes++);
    expect(c.current().sort).toBe("newest");
    c.sort.value = "rating";
    c.sort.dispatchEvent(new Event("change"));
    const status = c.filters.querySelector("select")!;
    status.value = "watched";
    status.dispatchEvent(new Event("change"));
    (c.filters.querySelector("button.toggle") as HTMLButtonElement).click();
    expect(changes).toBe(3);
    expect(c.current()).toEqual({
      sort: "rating",
      filter: { status: "watched", genre: "", onPhone: true },
    });
    // a fresh mount reads the same choices back
    const again = listControls("fp.t", () => {});
    expect(again.current()).toEqual(c.current());
    // the Listen variant has no status select and ignores a saved status
    const listen = listControls("fp.t", () => {}, { status: false });
    expect(listen.filters.querySelectorAll("select").length).toBe(1);
    expect(listen.current().filter.status).toBe("all");
  });

  it("offers only the genres on screen and shows n of N while filtering", () => {
    localStorage.clear();
    const c = listControls("fp.g", () => {});
    const jobs = [job("a", { genre: "vlog" }), job("b", { genre: "comedy" }), job("c")];
    c.update(jobs, 3);
    const genre = c.filters.querySelectorAll("select")[1];
    expect([...genre.options].map((o) => o.value)).toEqual(["", "comedy", "vlog"]);
    expect(c.filters.querySelector(".count")!.textContent).toBe("");
    genre.value = "vlog";
    genre.dispatchEvent(new Event("change"));
    c.update(jobs, 1);
    expect(c.filters.querySelector(".count")!.textContent).toBe("1 of 3");
    // clear button resets everything
    (c.filters.querySelector("button.clear") as HTMLButtonElement).click();
    expect(c.current().filter.genre).toBe("");
  });
});
