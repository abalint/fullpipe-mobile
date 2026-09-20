// DOM-level smoke tests for the pieces with real logic: ruby markup, tap
// cycling, and the outbox round-trip (incl. idempotent batch_id). The player
// (SRT parsing, cue lookup, overlay taps, the under-video actions) is
// covered in player.test.ts.
// Run: npx vitest run

import { beforeEach, describe, expect, it, vi } from "vitest";
import demo from "./demo-prep.json";
import type {
  ListWord,
  PrepDoc,
  TapBatch,
} from "./types";
import { rubyWord } from "./prep-render";
import {
  actionEpisode,
  getOutbox,
  getSubmitted,
  getTaps,
  pendingRating,
  pendingSeriesRating,
  pendingTapCount,
  pendingWatched,
  queueEnqueue,
  queuePassive,
  queueRating,
  queueSeriesRating,
  queueWatched,
  removeEpisodeActions,
  saveSettings,
  submitTaps,
  recordLookup,
  getLookups,
  phraseTapKey,
  clearTaps,
  cycleTap,
  getMarkContext,
} from "./store";
import { flushOutbox } from "./sync";
import { api, ApiError } from "./api";
import { backlogSeconds, hms, jobRow, pendingVideoDownloads, seriesBlock, seriesSection, sortJobs, starBar, thumbsBlock }
  from "./views/queue";
import { groupSeries } from "./series";
import { statsView } from "./views/stats";
import { confirmView } from "./views/confirm";
import { wordListView } from "./views/wordlist";
import { cacheStats } from "./store";
import type { ConfirmCandidate, Job, Stats } from "./types";

const doc = demo as unknown as PrepDoc;
const ep = doc.episode.id;

beforeEach(() => {
  localStorage.clear();
});

describe("tap cycle", () => {
  it("cycles known → high-interest → unknown → clear and persists across reads", () => {
    const lemma = doc.glossary[0].lemma;
    expect(cycleTap(ep, lemma)).toBe("k");
    expect(getTaps(ep)[lemma]).toBe("k");
    expect(cycleTap(ep, lemma)).toBe("h");
    expect(getTaps(ep)[lemma]).toBe("h");
    expect(cycleTap(ep, lemma)).toBe("u");
    expect(getTaps(ep)[lemma]).toBe("u");
    expect(cycleTap(ep, lemma)).toBeUndefined();
    expect(getTaps(ep)[lemma]).toBeUndefined();
  });
});

describe("rubyWord", () => {
  const html = (n: Node): string => {
    const d = document.createElement("div");
    d.appendChild(n);
    return d.innerHTML;
  };

  it("puts furigana over the kanji core only, peeling okurigana", () => {
    expect(html(rubyWord("切ない", "せつない"))).toBe("<ruby>切<rt>せつ</rt></ruby>ない");
    expect(html(rubyWord("通す", "とおす"))).toBe("<ruby>通<rt>とお</rt></ruby>す");
    expect(html(rubyWord("お茶", "おちゃ"))).toBe("お<ruby>茶<rt>ちゃ</rt></ruby>");
  });

  it("keeps whole-word ruby when there is no okurigana", () => {
    expect(html(rubyWord("大丈夫", "だいじょうぶ"))).toBe(
      "<ruby>大丈夫<rt>だいじょうぶ</rt></ruby>",
    );
  });

  it("normalizes katakana readings for the peel", () => {
    expect(html(rubyWord("切ない", "セツナイ"))).toBe("<ruby>切<rt>せつ</rt></ruby>ない");
  });

  it("passes kana-only and readingless words through bare", () => {
    expect(html(rubyWord("くれる", "くれる"))).toBe("くれる");
    expect(html(rubyWord("ノート"))).toBe("ノート");
  });
});

describe("outbox", () => {
  it("carries the episode's popup lookups in the batch, cumulative, and clears them at close-out", () => {
    recordLookup(ep, "犬", "should_know", "on");
    recordLookup(ep, "犬", "none", "kw");
    recordLookup(ep, phraseTapKey("気を付ける"), "interest");
    let batch = submitTaps(ep);
    expect(batch.lookups).toEqual([
      ["犬", 2, { should_know: 1, none: 1 }, "", { on: 1, kw: 1 }],
      ["気を付ける", 1, { interest: 1 }, "phrase"],
    ]);
    expect(batch.taps).toEqual([]);
    recordLookup(ep, "犬", "none", "kw");
    batch = submitTaps(ep);
    expect(batch.lookups![0]).toEqual(["犬", 3, { should_know: 1, none: 2 }, "", { on: 1, kw: 2 }]);
    clearTaps(ep);
    expect(getLookups(ep)).toEqual({});
    expect(submitTaps(ep).lookups).toBeUndefined();
  });

  it("tags a popup mark with what the word was painted as and where it was met", () => {
    cycleTap(ep, "犬", "confirm", "off"); // ✓ on a blue word, subs hidden
    cycleTap(ep, "猫"); // no context at all
    cycleTap(ep, "鳥", undefined, "prep"); // prep-doc tap: no paint, but a place
    cycleTap(ep, phraseTapKey("気を付ける"), "interest");
    expect(submitTaps(ep).taps).toEqual([
      ["犬", "k", "", "confirm", "off"],
      ["猫", "k"],
      ["鳥", "k", "", "", "prep"],
      ["気を付ける", "k", "phrase", "interest"],
    ]);
    clearTaps(ep);
    expect(getMarkContext(ep)).toEqual({});
  });

  it("freezes taps into a batch but retains the marks as a submitted baseline", () => {
    const lemma = doc.glossary[0].lemma;
    cycleTap(ep, lemma);

    const batch = submitTaps(ep);
    expect(batch.batch_id).toMatch(/^[0-9a-f]{16}$/);
    expect(batch.taps.length).toBe(1);
    expect(getOutbox().length).toBe(1);
    // marks survive the submit (so a reopened doc still shows them)…
    expect(getTaps(ep)[lemma]).toBe("k");
    // …recorded as the baseline, so there's nothing left "unsent"
    expect(getSubmitted(ep)[lemma]).toBe("k");
    expect(pendingTapCount(ep)).toBe(0);
  });

  it("counts a mark changed after submit as an unsent pending change", () => {
    const lemma = doc.glossary[0].lemma;
    cycleTap(ep, lemma); // k
    submitTaps(ep);
    expect(pendingTapCount(ep)).toBe(0);
    cycleTap(ep, lemma); // k → h, now diverges from the submitted baseline
    expect(pendingTapCount(ep)).toBe(1);
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
    expect(pendingRating(ep)).toEqual({
      rating: 5,
      tags: ["fascinating"],
      axes: {},
      follow: null,
      note: "",
    });
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
    cycleTap(ep, doc.glossary[0].lemma);
    submitTaps(ep);

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
    cycleTap(ep, doc.glossary[0].lemma);
    submitTaps(ep);
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
    words_encountered: 10389, want_to_learn: 49, should_know: 100,
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
    await vi.waitFor(() => expect(root.querySelectorAll(".ledger .stat-tile").length).toBe(4));
    // the immersion-time section sits above the ledger tiles, own tiles + empty state
    expect(root.querySelectorAll(".viewtime .stat-tile").length).toBe(5);
    expect(root.querySelector(".viewtime")!.textContent).toContain("Nothing recorded yet");
    // top-1000 tile shows 95% (948/1000)
    expect(root.textContent).toContain("95%");
    // one coverage bar per frequency band, filled to the pct
    const fills = root.querySelectorAll<HTMLElement>(".ledger .freqfill"); // the goal card has one too
    expect(fills.length).toBe(2);
    expect(fills[0].style.width).toBe("95%");
    // confirm-words banner links to the confirm queue
    const banner = root.querySelector<HTMLAnchorElement>("a.confirm-banner");
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("href")).toBe("#/confirm");
    expect(banner!.textContent).toContain("3 items");
    // the ★ and should-know lists get their own review links (LIVE_REVIEW.md §1)
    const links = [...root.querySelectorAll<HTMLAnchorElement>("a.confirm-banner")]
      .map((a) => a.getAttribute("href"));
    expect(links).toEqual(["#/confirm", "#/list/interest", "#/list/should_know"]);
    expect(root.querySelector(".cb-interest")!.textContent).toContain("49 words");
    expect(root.querySelector(".cb-should")!.textContent).toContain("100 most common");
    root.remove();
    vi.restoreAllMocks();
  });

  it("hides list banners a pre-list server / empty list can't fill", async () => {
    vi.spyOn(api, "getStats").mockResolvedValue({ ...stats, want_to_learn: 0, should_know: undefined });
    const root = statsView();
    document.body.appendChild(root);
    await vi.waitFor(() => expect(root.querySelectorAll(".ledger .stat-tile").length).toBe(4));
    expect(root.querySelectorAll("a.confirm-banner").length).toBe(1);
    root.remove();
    vi.restoreAllMocks();
  });

  it("falls back to the cached snapshot when the server is unreachable", async () => {
    cacheStats(stats);
    vi.spyOn(api, "getStats").mockRejectedValue(new ApiError("Server unreachable"));
    const root = statsView();
    document.body.appendChild(root);
    // cached numbers paint immediately even though the fetch fails
    expect(root.querySelectorAll(".ledger .stat-tile").length).toBe(4);
    await vi.waitFor(() =>
      expect(root.querySelector(".status")!.textContent).toMatch(/offline/));
    root.remove();
    vi.restoreAllMocks();
  });
});

describe("wordListView", () => {
  const words: ListWord[] = [
    { lemma: "猫", kind: "word", reading: "ねこ", reading_segs: [["猫", "ねこ"]],
      freq_rank: 12, exposure_count: 0, episode_spread: 0, episodes: [],
      senses: [{ k: ["猫"], r: ["ねこ"], s: [{ pos: ["n"], g: ["cat"] }] }] },
    { lemma: "設計", kind: "word", reading: "せっけい", reading_segs: [["設計", "せっけい"]],
      freq_rank: 900, exposure_count: 3, episode_spread: 2, episodes: ["Ep A", "Ep B"] },
  ];

  it("renders the should-know list with rank, gloss, ✓ and ★ actions", async () => {
    const get = vi.spyOn(api, "getWordList").mockResolvedValue({ list: "should_know", words });
    const mark = vi.spyOn(api, "markListWord").mockResolvedValue({
      lemma: "猫", mark: "h", status: "unknown", interest: true });
    const root = wordListView("should_know");
    document.body.appendChild(root);
    await vi.waitFor(() => expect(root.querySelectorAll(".confirm-card").length).toBe(2));
    expect(get).toHaveBeenCalledWith("should_know");
    expect(root.querySelector(".status")!.textContent).toContain("2 words");
    expect(root.textContent).toContain("cat"); // JMdict gloss
    expect(root.querySelector(".cc-rank")!.textContent).toBe("#12");
    expect(root.querySelector(".cc-seen")!.textContent).toBe("not yet seen");
    const buttons = root.querySelectorAll<HTMLButtonElement>(".confirm-card .cc-actions button");
    expect([...buttons].slice(0, 2).map((b) => b.textContent)).toEqual(["✓ I know it", "★ Want to learn"]);
    buttons[1].click(); // ★ → onto the want-to-learn list, off this one
    await vi.waitFor(() => expect(root.querySelectorAll(".confirm-card").length).toBe(1));
    expect(mark).toHaveBeenCalledWith("猫", "h");
    expect(root.querySelector(".status")!.textContent).toContain("1 word");
    root.remove();
    vi.restoreAllMocks();
  });

  it("the ★ list offers only ✓ and empties to its own message", async () => {
    vi.spyOn(api, "getWordList").mockResolvedValue({ list: "interest", words: [words[1]] });
    const mark = vi.spyOn(api, "markListWord").mockResolvedValue({
      lemma: "設計", mark: "k", status: "known", interest: false });
    const root = wordListView("interest");
    document.body.appendChild(root);
    await vi.waitFor(() => expect(root.querySelectorAll(".confirm-card").length).toBe(1));
    const buttons = root.querySelectorAll<HTMLButtonElement>(".confirm-card .cc-actions button");
    expect(buttons.length).toBe(1);
    expect(root.querySelector(".cc-seen")!.textContent).toBe("seen in 2 episodes");
    buttons[0].click();
    await vi.waitFor(() => expect(root.querySelectorAll(".confirm-card").length).toBe(0));
    expect(mark).toHaveBeenCalledWith("設計", "k");
    expect(root.querySelector(".status")!.textContent).toMatch(/Nothing starred/);
    root.remove();
    vi.restoreAllMocks();
  });

  it("reports when the server is unreachable", async () => {
    vi.spyOn(api, "getWordList").mockRejectedValue(new ApiError("Server unreachable"));
    const root = wordListView("interest");
    document.body.appendChild(root);
    await vi.waitFor(() =>
      expect(root.querySelector(".status")!.textContent).toMatch(/needs the server/));
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
    expect(root.querySelector(".status")!.textContent).toContain("2 items");
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
      kind: "word", key: "行く", known: true, status: "known" });
    const root = confirmView();
    document.body.appendChild(root);
    await vi.waitFor(() => expect(root.querySelectorAll(".confirm-card").length).toBe(2));
    root.querySelector<HTMLButtonElement>(".confirm-card .primary")!.click();
    await vi.waitFor(() => expect(root.querySelectorAll(".confirm-card").length).toBe(1));
    expect(confirm).toHaveBeenCalledWith("word", "行く", true);
    expect(root.querySelector(".status")!.textContent).toContain("1 left");
    root.remove();
    vi.restoreAllMocks();
  });

  it("renders typed phrase and grammar cards (GRAMMAR.md)", async () => {
    const typed: ConfirmCandidate[] = [
      { lemma: "気を付ける", kind: "phrase", reading: "きをつける",
        reading_segs: [["気", "き"], ["を", null], ["付", "つ"], ["ける", null]],
        exposure_count: 6, episode_spread: 4, episodes: ["Ep A"],
        senses: [{ k: ["気を付ける"], r: ["きをつける"],
                   s: [{ pos: ["exp"], g: ["to be careful"] }] }] },
      { lemma: "〜てしまう", kind: "grammar", pattern: "〜てしまう", level: 4,
        gloss: "completion or regret", exposure_count: 3, episode_spread: 3,
        episodes: ["Ep B"] },
    ];
    vi.spyOn(api, "getConfirmQueue").mockResolvedValue({ candidates: typed });
    const confirm = vi.spyOn(api, "confirmWord").mockResolvedValue({
      kind: "grammar", key: "〜てしまう", known: true, status: "known" });
    const root = confirmView();
    document.body.appendChild(root);
    await vi.waitFor(() => expect(root.querySelectorAll(".confirm-card").length).toBe(2));
    const badges = [...root.querySelectorAll(".cc-badge")].map((b) => b.textContent);
    expect(badges).toEqual(["phrase", "N4"]);
    expect(root.textContent).toContain("to be careful"); // phrase JMdict gloss
    expect(root.textContent).toContain("completion or regret"); // taxonomy gloss
    // answering the grammar card sends the typed key
    const grammarCard = root.querySelectorAll(".confirm-card")[1]!;
    grammarCard.querySelector<HTMLButtonElement>(".primary")!.click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith("grammar", "〜てしまう", true));
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

describe("backlogSeconds", () => {
  const job = (episode_id: string, extra: Partial<Job>): Job =>
    ({ episode_id, source: "s", state: "staged", duration: 600, ...extra }) as Job;

  it("sums unwatched staged and reconciled episodes", () => {
    expect(
      backlogSeconds([
        job("a", {}),
        job("b", { state: "reconciled", duration: 300 }),
        job("c", { state: "watched" }), // done
        job("d", { state: "prepared" }), // still in stage 1, not staged yet
        job("e", { duration: null }), // duration unknown
      ]),
    ).toBe(900);
  });

  it("excludes passive-shelved episodes — they live on the Listen tab", () => {
    expect(backlogSeconds([job("a", {}), job("b", { passive: true })])).toBe(600);
  });

  it("excludes an episode shelved offline, before the outbox flushes", () => {
    // the row is already gone from the queue list; the total must follow it
    queuePassive("b", true);
    expect(backlogSeconds([job("a", {}), job("b", {})])).toBe(600);
  });

  it("excludes an episode marked watched offline, while the state is stale", () => {
    queueWatched("b", false);
    expect(backlogSeconds([job("a", {}), job("b", {})])).toBe(600);
  });
});

describe("pendingVideoDownloads", () => {
  const job = (episode_id: string, extra: Partial<Job>): Job =>
    ({ episode_id, source: "s", state: "staged", ...extra }) as Job;
  const ids = (jobs: Job[]) => pendingVideoDownloads(jobs).map((j) => j.episode_id);

  it("takes staged episodes that aren't on the phone yet", () => {
    expect(
      ids([
        job("a", {}),
        job("b", { state: "reconciled" }),
        job("c", { state: "queued" }), // stage 1 hasn't staged a video
        job("d", { state: "watched" }),
      ]),
    ).toEqual(["a", "b"]);
  });

  it("skips an episode already downloaded", () => {
    localStorage.setItem("fp.video.a", JSON.stringify({ path: "a.mp4" }));
    expect(ids([job("a", {}), job("b", {})])).toEqual(["b"]);
  });

  it("skips page jobs — they have no video and the fetch 404s", () => {
    expect(ids([job("a", {}), job("page_5ch_newsplus_1", { kind: "page" })])).toEqual(["a"]);
  });
});

describe("jobRow video actions", () => {
  const job = (extra: Partial<Job>): Job =>
    ({ episode_id: "ep1", source: "s", state: "staged", ...extra }) as Job;
  const labels = (row: HTMLElement) =>
    [...row.querySelectorAll("a,button")].map((n) => n.textContent);

  it("offers a re-download beside play once the video is on the phone", () => {
    localStorage.setItem("fp.video.ep1", JSON.stringify({ path: "videos/ep1.mp4" }));
    const row = jobRow(job({}), () => {});
    expect(labels(row)).toContain("▶ play");
    // the escape hatch for a record that outlived a usable file
    expect(labels(row)).toContain("↻");
  });

  it("offers only a download when the phone has no copy", () => {
    const row = jobRow(job({}), () => {});
    expect(labels(row)).toContain("⬇ video");
    expect(labels(row)).not.toContain("↻");
  });

  it("hides the re-download when offline", () => {
    localStorage.setItem("fp.video.ep1", JSON.stringify({ path: "videos/ep1.mp4" }));
    const row = jobRow(job({}), () => {}, undefined, true);
    expect(labels(row)).toContain("▶ play");
    expect(labels(row)).not.toContain("↻");
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

describe("seriesBlock (series.ts grouping on the queue)", () => {
  const ep = (n: number, state: Job["state"] = "staged"): Job =>
    ({
      episode_id: `ser_hotspot_e0${n}`, source: `series://hotspot/${n}`, state,
      title: `Hot Spot EP0${n}`, series: "hotspot", series_title: "Hot Spot", ep_no: n,
    }) as Job;
  it("orders episodes, counts progress, and offers the next unwatched one", () => {
    localStorage.setItem("fp.video.ser_hotspot_e02", JSON.stringify({ path: "v", size: 1, at: "" }));
    const g = groupSeries([ep(3), ep(1, "watched"), ep(2)]).series[0];
    const block = seriesBlock(g, () => {}, undefined, false);
    const head = block.querySelector(".series-head")!;
    expect(head.querySelector(".series-title")!.textContent).toBe("Hot Spot");
    expect(head.textContent).toContain("1/3 watched");
    expect(head.textContent).toContain("1 on phone");
    // EP02 is the next unwatched and is downloaded → a play link
    const play = head.querySelector<HTMLAnchorElement>("a.btn")!;
    expect(play.textContent).toBe("▶ EP02");
    expect(play.getAttribute("href")).toBe("#/player/ser_hotspot_e02");
    const chips = [...block.querySelectorAll(".series-body .chip.ep")].map((c) => c.textContent);
    expect(chips).toEqual(["EP01", "EP02", "EP03"]);
  });
  it("offers a download when the next episode is not on the phone", () => {
    const g = groupSeries([ep(1), ep(2)]).series[0];
    const block = seriesBlock(g, () => {}, undefined, false);
    expect(block.querySelector(".series-head button")!.textContent).toBe("⬇ EP01");
  });
  it("honours the phone's own finished evidence a /jobs fetch ahead of the server", () => {
    // EP02 was just played to the end; the server row still says "staged"
    const g = groupSeries([ep(1, "watched"), ep(2), ep(3)]).series[0];
    const block = seriesBlock(g, () => {}, undefined, false, new Set(["ser_hotspot_e02"]));
    const head = block.querySelector(".series-head")!;
    expect(head.textContent).toContain("2/3 watched");
    expect(head.querySelector("button")!.textContent).toBe("\u2b07 EP03");
    const chips = [...block.querySelectorAll(".series-body .chip[class*=\"st-\"]")]
      .map((c) => c.textContent);
    expect(chips).toEqual(["watched", "watched", "staged"]);
  });
  it("collapses and remembers it", () => {
    const g = groupSeries([ep(1)]).series[0];
    const block = seriesBlock(g, () => {});
    (block.querySelector(".series-head") as HTMLElement).click();
    expect(block.classList.contains("collapsed")).toBe(true);
    expect(localStorage.getItem("fp.series.collapsed.hotspot")).toBe("1");
  });
  it("rates the set as a whole on the header; episode rows carry no survey", () => {
    const rows = [ep(1, "watched"), ep(2, "staged")].map((j) => ({ ...j, series_rating: 2 as const }));
    const g = groupSeries(rows).series[0];
    const block = seriesBlock(g, () => {});
    const head = block.querySelector(".series-head")!;
    const up = head.querySelector<HTMLButtonElement>(".thumb.up")!;
    expect(up.textContent).toBe("👍👍");
    expect(up.classList.contains("dbl")).toBe(true);
    expect(head.querySelector(".thumb.down")!.classList.contains("on")).toBe(false);
    expect(block.querySelectorAll(".series-body .rating").length).toBe(0);
    expect(block.querySelectorAll(".series-body .stars").length).toBe(0);
    // tapping the thumb doesn't fold the header
    up.click();
    expect(block.classList.contains("collapsed")).toBe(false);
  });
});

describe("thumbsBlock (whole-series thumbs)", () => {
  it("cycles 👍 → 👍👍 → 👍 and flips sides, coalescing taps into one queued verdict", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 0 }))); // unreachable
    const w = thumbsBlock("hotspot", null);
    const up = w.querySelector<HTMLButtonElement>(".thumb.up")!;
    const down = w.querySelector<HTMLButtonElement>(".thumb.down")!;
    expect(up.classList.contains("on")).toBe(false);
    up.click();
    expect(up.textContent).toBe("👍");
    expect(up.classList.contains("on")).toBe(true);
    up.click();
    expect(up.textContent).toBe("👍👍");
    up.click();
    expect(up.textContent).toBe("👍");
    down.click();
    expect(up.classList.contains("on")).toBe(false);
    expect(down.textContent).toBe("👎");
    down.click();
    expect(down.textContent).toBe("👎👎");
    expect(getOutbox().length).toBe(0); // still debouncing
    await vi.advanceTimersByTimeAsync(500);
    const queued = getOutbox().filter((a) => a.kind === "series_rating");
    expect(queued.length).toBe(1); // five taps → one review
    expect(queued[0].kind === "series_rating" && queued[0].rating).toBe(-2);
    expect(pendingSeriesRating("hotspot")?.rating).toBe(-2);
    // a fresh block reads the pending verdict over a stale server value
    const again = thumbsBlock("hotspot", 1);
    expect(again.querySelector(".thumb.down")!.textContent).toBe("👎👎");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("flushes as POST /series/{slug}/rating with a replay-safe review_id", async () => {
    saveSettings({ serverUrl: "http://pc.ts.net:8321", token: "tok" });
    queueSeriesRating("hotspot", 2);
    queueSeriesRating("hotspot", 1); // replaces the unsent one
    expect(getOutbox().filter((a) => a.kind === "series_rating").length).toBe(1);
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        posted.push({ url: String(url), body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify({ series: "hotspot", rating: 1 }), { status: 200 });
      }),
    );
    const res = await flushOutbox();
    expect(res.sent).toBe(1);
    expect(posted[0].url).toBe("http://pc.ts.net:8321/series/hotspot/rating");
    expect(posted[0].body.rating).toBe(1);
    expect(typeof posted[0].body.review_id).toBe("string");
    expect(pendingSeriesRating("hotspot")).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("seriesSection (the queue's collapsible Series shelf)", () => {
  const ep = (slug: string, n: number): Job =>
    ({
      episode_id: `ser_${slug}_e0${n}`, source: `series://${slug}/${n}`, state: "staged",
      title: `${slug} EP0${n}`, series: slug, series_title: slug.toUpperCase(), ep_no: n,
    }) as Job;
  beforeEach(() => localStorage.clear());

  it("returns null with no series", () => {
    expect(seriesSection([], () => {})).toBeNull();
  });

  it("splits series into on-phone / not-on-phone shelves, each series still its own block", () => {
    localStorage.setItem("fp.video.ser_alpha_e01", JSON.stringify({ path: "x", bytes: 1 }));
    const groups = groupSeries([ep("alpha", 1), ep("alpha", 2), ep("beta", 1)]).series;
    const section = seriesSection(groups, () => {})!;
    expect(section.classList.contains("series-section")).toBe(true);
    expect(section.querySelector(":scope > .series-head .series-title")!.textContent).toBe("Series");
    expect(section.querySelector(":scope > .series-head .muted:last-child")!.textContent)
      .toBe("2 · 1 on phone");
    const shelves = [...section.querySelectorAll(":scope > .series-body > .series-shelf")];
    expect(shelves.map((s) => s.querySelector(".series-title")!.textContent)).toEqual([
      "On phone", "Not on phone",
    ]);
    expect([...shelves[0].querySelectorAll(":scope > .series-body > .series .series-title")]
      .map((e) => e.textContent)).toEqual(["ALPHA"]);
    expect([...shelves[1].querySelectorAll(":scope > .series-body > .series .series-title")]
      .map((e) => e.textContent)).toEqual(["BETA"]);
    // not-on-phone starts folded, on-phone open, the section open
    expect(section.classList.contains("collapsed")).toBe(false);
    expect(shelves[0].classList.contains("collapsed")).toBe(false);
    expect(shelves[1].classList.contains("collapsed")).toBe(true);
  });

  it("omits an empty shelf and remembers the section's fold", () => {
    const section = seriesSection(groupSeries([ep("beta", 1)]).series, () => {})!;
    const shelves = [...section.querySelectorAll(".series-shelf")];
    expect(shelves.map((s) => s.querySelector(".series-title")!.textContent)).toEqual(["Not on phone"]);
    (section.querySelector(":scope > .series-head") as HTMLElement).click();
    expect(section.classList.contains("collapsed")).toBe(true);
    expect(localStorage.getItem("fp.series.section.collapsed")).toBe("1");
    // a shelf the user opened stays open on the next render
    (shelves[0].querySelector(":scope > .series-head") as HTMLElement).click();
    const again = seriesSection(groupSeries([ep("beta", 1)]).series, () => {})!;
    expect(again.querySelector(".series-shelf")!.classList.contains("collapsed")).toBe(false);
  });
});
