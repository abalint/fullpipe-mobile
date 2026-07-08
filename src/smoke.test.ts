// DOM-level smoke tests for the pieces with real logic: prep rendering, tap
// cycling, and the outbox round-trip (incl. idempotent batch_id). The player
// (SRT parsing, cue lookup, overlay taps) is covered in player.test.ts.
// Run: npx vitest run

import { beforeEach, describe, expect, it, vi } from "vitest";
import demo from "./demo-prep.json";
import type { PrepDoc, TapBatch } from "./types";
import { renderPrep } from "./prep-render";
import {
  actionEpisode,
  getOutbox,
  getSubmitted,
  getTaps,
  pendingRating,
  pendingTapCount,
  pendingWatched,
  queueEnqueue,
  queueRating,
  queueWatched,
  removeEpisodeActions,
  saveSettings,
  submitTaps,
} from "./store";
import { flushOutbox } from "./sync";
import { api, ApiError } from "./api";
import { hms, sortJobs, starBar } from "./views/queue";
import { statsView } from "./views/stats";
import { confirmView } from "./views/confirm";
import { cacheStats } from "./store";
import type { ConfirmCandidate, Job, Stats } from "./types";

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

  it("drops a deleted episode's actions but keeps others", () => {
    submitTaps(ep);
    queueWatched(ep, true);
    submitTaps("yt_other");
    removeEpisodeActions(ep);
    const left = getOutbox();
    expect(left.length).toBe(1);
    expect(actionEpisode(left[0])).toBe("yt_other");
  });

  it("migrates a pre-typed outbox of bare TapBatch entries in place", () => {
    const legacy: TapBatch = { episode_id: ep, batch_id: "abc123", taps: [["犬", "k"]] };
    localStorage.setItem("fp.outbox", JSON.stringify([legacy]));
    const out = getOutbox();
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("taps");
    expect(out[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(actionEpisode(out[0])).toBe(ep);
    // persisted migrated, so the next read is already typed
    expect(JSON.parse(localStorage.getItem("fp.outbox")!)[0].kind).toBe("taps");
  });

  it("keeps only the latest queued watched/rating per episode", () => {
    queueWatched(ep, true);
    queueWatched(ep, false); // changed their mind: no cards
    queueRating(ep, 3, []);
    queueRating(ep, 5, ["fascinating"]); // offline re-rate replaces, not appends
    expect(getOutbox().length).toBe(2);
    expect(pendingWatched(ep)).toEqual({ cards: false });
    expect(pendingRating(ep)).toEqual({ rating: 5, tags: ["fascinating"] });
  });

  it("dedupes identical queued enqueues (POST /jobs is idempotent anyway)", () => {
    queueEnqueue("https://youtu.be/x");
    queueEnqueue("https://youtu.be/x");
    expect(getOutbox().length).toBe(1);
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

  it("flushes mixed actions FIFO to their endpoints (taps before watched)", async () => {
    saveSettings({ serverUrl: "http://pc.ts.net:8321", token: "tok" });
    submitTaps(ep); // feedback first…
    queueWatched(ep, true); // …then the close-out, as the user did them
    queueRating(ep, 4, ["fascinating"]);
    queueEnqueue("https://youtu.be/next1234567");

    const calls: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          path: new URL(String(url)).pathname,
          body: JSON.parse((init.body as string) ?? "{}"),
        });
        return new Response("{}", { status: 200 });
      }),
    );
    const res = await flushOutbox();
    expect(res.sent).toBe(4);
    expect(getOutbox().length).toBe(0);
    expect(calls.map((c) => c.path)).toEqual([
      "/taps",
      `/watched/${ep}`,
      `/episodes/${ep}/rating`,
      "/jobs",
    ]);
    expect(calls[1].body).toEqual({ cards: true });
    expect(calls[2].body.rating).toBe(4);
    expect(calls[2].body.review_id).toMatch(/^[0-9a-f]{16}$/); // replay-safe
    vi.unstubAllGlobals();
  });

  it("drops permanently rejected actions instead of poisoning the queue", async () => {
    saveSettings({ serverUrl: "http://pc.ts.net:8321", token: "tok" });
    queueWatched("yt_deleted", true); // episode gone server-side → 404
    queueRating(ep, 4, []);

    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        paths.push(new URL(String(url)).pathname);
        return String(url).includes("yt_deleted")
          ? new Response("no such episode", { status: 404 })
          : new Response("{}", { status: 200 });
      }),
    );
    const res = await flushOutbox();
    expect(res.dropped).toBe(1);
    expect(res.sent).toBe(1);
    expect(getOutbox().length).toBe(0); // the 404 didn't block the rating behind it
    expect(paths.length).toBe(2);
    vi.unstubAllGlobals();
  });
});

describe("api request timeout", () => {
  it("aborts a hung request and reports it as unreachable (no HTTP status)", async () => {
    saveSettings({ serverUrl: "http://pc.ts.net:8321", token: "tok" });
    vi.useFakeTimers();
    // a server that accepts the connection but never answers — the fetch only
    // settles when its AbortSignal fires, exactly like a dead host on the tailnet
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );
    const settled = api.listJobs().then(
      () => ({ ok: true }) as const,
      (e) => ({ ok: false, e }) as const,
    );
    await vi.advanceTimersByTimeAsync(6000); // trip the deadline
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.e).toBeInstanceOf(ApiError);
      // undefined status → callers park writes in the outbox / fall back to the
      // cached queue, rather than treating it as a hard rejection
      expect((outcome.e as ApiError).status).toBeUndefined();
      expect((outcome.e as ApiError).message).toMatch(/timed out/);
    }
    vi.useRealTimers();
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

describe("statsView", () => {
  const stats: Stats = {
    known: 3442, learning: 218, episodes_watched: 27, episodes_total: 46,
    cards_minted: 240, needs_review: 0, confirm_candidates: 3,
    words_encountered: 10389, want_to_learn: 49,
    freq_bands: [
      { band: 1000, known: 948, total: 1000 },
      { band: 2000, known: 1344, total: 2000 },
    ],
    evidence_by_source: { exposure: 26140, tap_known: 391 },
  };

  it("renders headline tiles and a coverage bar per band", async () => {
    vi.spyOn(api, "getStats").mockResolvedValue(stats);
    const root = statsView();
    document.body.appendChild(root);
    await vi.waitFor(() => expect(root.querySelectorAll(".stat-tile").length).toBe(4));
    // top-1000 tile shows 95% (948/1000)
    expect(root.textContent).toContain("95%");
    // one coverage bar per frequency band, filled to the pct
    const fills = root.querySelectorAll<HTMLElement>(".freqfill");
    expect(fills.length).toBe(2);
    expect(fills[0].style.width).toBe("95%");
    // confirm-words banner links to the confirm queue
    const banner = root.querySelector<HTMLAnchorElement>("a.confirm-banner");
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("href")).toBe("#/confirm");
    expect(banner!.textContent).toContain("3 words");
    root.remove();
    vi.restoreAllMocks();
  });

  it("falls back to the cached snapshot when the server is unreachable", async () => {
    cacheStats(stats);
    vi.spyOn(api, "getStats").mockRejectedValue(new ApiError("Server unreachable"));
    const root = statsView();
    document.body.appendChild(root);
    // cached numbers paint immediately even though the fetch fails
    expect(root.querySelectorAll(".stat-tile").length).toBe(4);
    await vi.waitFor(() =>
      expect(root.querySelector(".status")!.textContent).toMatch(/offline/));
    root.remove();
    vi.restoreAllMocks();
  });
});

describe("confirmView", () => {
  const cands: ConfirmCandidate[] = [
    { lemma: "行く", reading: "いく", reading_segs: [["行", "い"], ["く", null]],
      freq_rank: 0, exposure_count: 24, episode_spread: 24, episodes: ["Ep A", "Ep B"],
      senses: [{ k: ["行く"], r: ["いく"], s: [{ pos: ["v5k-s"], g: ["to go"] }] }] },
    { lemma: "来る", reading: "くる", reading_segs: [["来", "く"], ["る", null]],
      freq_rank: 4, exposure_count: 24, episode_spread: 24, episodes: [] },
  ];

  it("renders a card per candidate with a gloss and answer buttons", async () => {
    vi.spyOn(api, "getConfirmQueue").mockResolvedValue({ candidates: cands });
    const root = confirmView();
    document.body.appendChild(root);
    await vi.waitFor(() => expect(root.querySelectorAll(".confirm-card").length).toBe(2));
    expect(root.textContent).toContain("to go"); // JMdict gloss shown
    expect(root.querySelector(".status")!.textContent).toContain("2 words");
    // furigana lands on the kanji only: 行 is inside a <ruby> with rt い, and
    // the okurigana く is a bare text node (no ruby over it)
    const firstWord = root.querySelector(".cc-word")!;
    const ruby = firstWord.querySelector("ruby")!;
    expect(ruby.querySelector("rt")!.textContent).toBe("い");
    expect(ruby.firstChild!.textContent).toBe("行"); // ruby base is the kanji only
    expect(firstWord.lastChild!.textContent).toBe("く"); // trailing く stays bare
    root.remove();
    vi.restoreAllMocks();
  });

  it("removes a card once answered and counts down", async () => {
    vi.spyOn(api, "getConfirmQueue").mockResolvedValue({ candidates: cands });
    const confirm = vi.spyOn(api, "confirmWord").mockResolvedValue({
      lemma: "行く", known: true, status: "known" });
    const root = confirmView();
    document.body.appendChild(root);
    await vi.waitFor(() => expect(root.querySelectorAll(".confirm-card").length).toBe(2));
    root.querySelector<HTMLButtonElement>(".confirm-card .primary")!.click();
    await vi.waitFor(() => expect(root.querySelectorAll(".confirm-card").length).toBe(1));
    expect(confirm).toHaveBeenCalledWith("行く", true);
    expect(root.querySelector(".status")!.textContent).toContain("1 left");
    root.remove();
    vi.restoreAllMocks();
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
