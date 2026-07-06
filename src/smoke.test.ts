// DOM-level smoke tests for the pieces with real logic: prep rendering, tap
// cycling, and the outbox round-trip (incl. idempotent batch_id). The player
// (SRT parsing, cue lookup, overlay taps) is covered in player.test.ts.
// Run: npx vitest run

import { beforeEach, describe, expect, it, vi } from "vitest";
import demo from "./demo-prep.json";
import type { PrepDoc, TapBatch } from "./types";
import { renderPrep } from "./prep-render";
import {
  getOutbox,
  getSubmitted,
  getTaps,
  pendingTapCount,
  removeEpisodeBatches,
  saveSettings,
  submitTaps,
} from "./store";
import { flushOutbox } from "./sync";
import { hms, sortJobs, starBar } from "./views/queue";
import type { Job } from "./types";

const doc = demo as unknown as PrepDoc;
const ep = doc.episode.id;

beforeEach(() => {
  localStorage.clear();
});

describe("renderPrep", () => {
  it("renders glossary rows, sentences, and stats", () => {
    const root = renderPrep(doc);
    expect(root.querySelectorAll(".gloss .w[data-lemma]").length).toBe(doc.glossary.length);
    expect(root.querySelectorAll(".sent").length).toBeGreaterThan(0);
    expect(root.querySelector(".stats")!.textContent).toContain("%");
  });

  it("masks glosses by default", () => {
    const root = renderPrep(doc);
    const masked = root.querySelectorAll(".m.masked");
    expect(masked.length).toBeGreaterThan(0);
    masked.forEach((m) => expect(m.textContent).toBe("···"));
  });

  it("cycles taps known → high-interest → clear and persists them", () => {
    const root = renderPrep(doc);
    document.body.appendChild(root);
    const w = root.querySelector<HTMLElement>(".gloss .w[data-lemma]")!;
    const lemma = w.dataset.lemma!;

    w.click();
    expect(getTaps(ep)[lemma]).toBe("k");
    expect(w.classList.contains("tap-k")).toBe(true);

    w.click();
    expect(getTaps(ep)[lemma]).toBe("h");
    expect(w.classList.contains("tap-h")).toBe(true);

    w.click();
    expect(getTaps(ep)[lemma]).toBeUndefined();
    root.remove();
  });
});

describe("outbox", () => {
  it("freezes taps into a batch but retains the marks as a submitted baseline", () => {
    const root = renderPrep(doc);
    document.body.appendChild(root);
    const w = root.querySelector<HTMLElement>(".gloss .w[data-lemma]")!;
    const lemma = w.dataset.lemma!;
    w.click();

    const batch = submitTaps(ep);
    expect(batch.batch_id).toMatch(/^[0-9a-f]{16}$/);
    expect(batch.taps.length).toBe(1);
    expect(getOutbox().length).toBe(1);
    // marks survive the submit (so a reopened doc still shows them)…
    expect(getTaps(ep)[lemma]).toBe("k");
    // …recorded as the baseline, so there's nothing left "unsent"
    expect(getSubmitted(ep)[lemma]).toBe("k");
    expect(pendingTapCount(ep)).toBe(0);
    root.remove();
  });

  it("counts a mark changed after submit as an unsent pending change", () => {
    const root = renderPrep(doc);
    document.body.appendChild(root);
    const w = root.querySelector<HTMLElement>(".gloss .w[data-lemma]")!;
    w.click(); // k
    submitTaps(ep);
    expect(pendingTapCount(ep)).toBe(0);
    w.click(); // k → h, now diverges from the submitted baseline
    expect(w.classList.contains("tap-committed")).toBe(false);
    expect(pendingTapCount(ep)).toBe(1);
    root.remove();
  });

  it("drops a deleted episode's batches but keeps others", () => {
    submitTaps(ep);
    submitTaps("yt_other");
    removeEpisodeBatches(ep);
    const left = getOutbox();
    expect(left.length).toBe(1);
    expect(left[0].episode_id).toBe("yt_other");
  });

  it("empty submit still makes a batch (no corrections = default selection)", () => {
    const batch = submitTaps(ep);
    expect(batch.taps).toEqual([]);
    expect(getOutbox().length).toBe(1);
  });

  it("flushes to POST /taps and drains; keeps the batch on failure", async () => {
    saveSettings({ serverUrl: "http://pc.ts.net:8321", token: "tok" });
    const root = renderPrep(doc);
    document.body.appendChild(root);
    root.querySelector<HTMLElement>(".gloss .w[data-lemma]")!.click();
    submitTaps(ep);
    root.remove();

    const posted: TapBatch[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(String(url)).toBe("http://pc.ts.net:8321/taps");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
        posted.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ applied: 1 }), { status: 200 });
      }),
    );
    const ok = await flushOutbox();
    expect(ok.sent).toBe(1);
    expect(getOutbox().length).toBe(0);
    expect(posted[0].episode_id).toBe(ep);

    // failure path: batch stays queued
    const r2 = renderPrep(doc);
    document.body.appendChild(r2);
    r2.querySelector<HTMLElement>(".gloss .w[data-lemma]")!.click();
    submitTaps(ep);
    r2.remove();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const bad = await flushOutbox();
    expect(bad.sent).toBe(0);
    expect(bad.remaining).toBe(1);
    expect(getOutbox().length).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe("starBar", () => {
  it("fills to the rating, sets on tap, clears on re-tap of the current star", () => {
    let sent: number | null | undefined;
    const bar = starBar(3, (r) => (sent = r));
    const stars = bar.querySelectorAll<HTMLButtonElement>(".star");
    expect(stars.length).toBe(5);
    expect([...stars].map((s) => s.classList.contains("on"))).toEqual(
      [true, true, true, false, false]);

    stars[4].click(); // different star → new rating
    expect(sent).toBe(5);
    stars[2].click(); // current rating → clear
    expect(sent).toBeNull();
  });
});

describe("hms", () => {
  it("formats seconds as hh:mm:ss", () => {
    expect(hms(0)).toBe("00:00:00");
    expect(hms(59.4)).toBe("00:00:59");
    expect(hms(838.759)).toBe("00:13:59");
    expect(hms(3600 + 25 * 60 + 10)).toBe("01:25:10");
    expect(hms(10 * 3600)).toBe("10:00:00");
  });
});

describe("sortJobs", () => {
  const job = (episode_id: string, extra: Partial<Job>): Job =>
    ({ episode_id, source: "s", state: "staged", ...extra }) as Job;
  const jobs: Job[] = [
    job("a", { created_at: "2026-07-01", comprehensibility: 0.5, duration: 600 }),
    job("b", { created_at: "2026-07-03", comprehensibility: 0.9, duration: 60 }),
    job("c", { created_at: "2026-07-02" }), // no coverage/duration staged yet
  ];
  const ids = (sorted: Job[]) => sorted.map((j) => j.episode_id);

  it("orders by created_at both ways", () => {
    expect(ids(sortJobs(jobs, "newest"))).toEqual(["b", "c", "a"]);
    expect(ids(sortJobs(jobs, "oldest"))).toEqual(["a", "c", "b"]);
  });

  it("orders by metric and sinks rows missing it", () => {
    expect(ids(sortJobs(jobs, "comp-desc"))).toEqual(["b", "a", "c"]);
    expect(ids(sortJobs(jobs, "comp-asc"))).toEqual(["a", "b", "c"]);
    expect(ids(sortJobs(jobs, "longest"))).toEqual(["a", "b", "c"]);
    expect(ids(sortJobs(jobs, "shortest"))).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the input", () => {
    const before = ids(jobs);
    sortJobs(jobs, "shortest");
    expect(ids(jobs)).toEqual(before);
  });
});
