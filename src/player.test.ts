// Player logic tests: SRT parsing, cue lookup by time, the tokenized subtitle
// overlay's tap wiring (same store as the prep doc), and resume positions.
// Run: npx vitest run

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cueIndexAt,
  cueTriggered,
  extendCues,
  keywordIndex,
  lastStartedAt,
  parseSrt,
  playerView,
} from "./views/player";
import type { Cue } from "./views/player";
import { cachePrep, getTaps, saveSettings } from "./store";
import { clearPosition, getPosition, savePosition } from "./video";
import type { PrepDoc } from "./types";

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("parseSrt", () => {
  it("parses cue numbers, comma timestamps, and multiline text", () => {
    const srt =
      "1\n00:00:01,000 --> 00:00:03,500\nこんにちは\n\n" +
      "2\n01:02:03,250 --> 01:02:04,000\n元気？\nですか\n";
    const cues = parseSrt(srt);
    expect(cues.length).toBe(2);
    expect(cues[0]).toEqual({ start: 1, end: 3.5, text: "こんにちは" });
    expect(cues[1].start).toBeCloseTo(3723.25);
    expect(cues[1].text).toBe("元気？\nですか");
  });

  it("skips malformed blocks instead of throwing", () => {
    const cues = parseSrt("garbage\n\n1\nnot a timing\ntext\n\n2\n00:00:05,000 --> 00:00:06,000\nok\n");
    expect(cues.length).toBe(1);
    expect(cues[0].text).toBe("ok");
  });
});

describe("cue lookup", () => {
  const cues: Cue[] = [
    { start: 0, end: 2, text: "a" },
    { start: 2, end: 4, text: "b" },
    { start: 10, end: 12, text: "c" }, // gap 4–10
  ];

  it("finds the covering cue, exclusive of end", () => {
    expect(cueIndexAt(cues, 0)).toBe(0);
    expect(cueIndexAt(cues, 1.9)).toBe(0);
    expect(cueIndexAt(cues, 2)).toBe(1);
    expect(cueIndexAt(cues, 11)).toBe(2);
  });

  it("returns -1 in gaps, before the first, and past the last", () => {
    expect(cueIndexAt(cues, 5)).toBe(-1);
    expect(cueIndexAt(cues, -1)).toBe(-1);
    expect(cueIndexAt(cues, 99)).toBe(-1);
    expect(cueIndexAt([], 0)).toBe(-1);
  });

  it("lastStartedAt anchors replay/prev/next even inside gaps", () => {
    expect(lastStartedAt(cues, 5)).toBe(1); // in the gap → cue that last started
    expect(lastStartedAt(cues, -1)).toBe(-1);
    expect(lastStartedAt(cues, 99)).toBe(2);
  });
});

describe("extendCues", () => {
  it("lets cues linger up to the cap, never past the next cue", () => {
    const out = extendCues([
      { start: 0, end: 2, text: "a" },
      { start: 3, end: 4, text: "b" },   // 1s gap → bridged fully
      { start: 10, end: 12, text: "c" }, // 6s gap → capped at +2.5
    ]);
    expect(out[0].end).toBe(3);
    expect(out[1].end).toBe(6.5);
    expect(out[2].end).toBe(14.5); // last cue lingers too
  });

  it("never shortens an overlapping cue", () => {
    const out = extendCues([
      { start: 0, end: 5, text: "a" },
      { start: 3, end: 6, text: "b" },
    ]);
    expect(out[0].end).toBe(5);
  });
});

const PREP: PrepDoc = {
  episode: { id: "yt_playertest", title: "テスト" },
  stats: { token_comprehensibility: 0.9, total_sentences: 2, i_plus_1: 1, reinforcement: 0 },
  curate: { focal_points: [{ word: "公園", why: "散歩の話の軸", why_segs: [["散歩の話の軸", null]] }] },
  glossary: [
    { lemma: "公園", reading: "こうえん", gloss: "park", note_segs: [["公園へ行く", null]] },
    { lemma: "犬", reading: "いぬ", gloss: "" }, // uncurated candidate — not a keyword
  ],
  iplus1: [],
  reinforcement: [],
  sentences_by_idx: {},
};

describe("keywordIndex / cueTriggered", () => {
  it("indexes glossed rows and focal points, skips empty-gloss candidates", () => {
    const kw = keywordIndex(PREP);
    expect(kw.has("公園")).toBe(true);
    expect(kw.get("公園")!.why).toBeTruthy(); // focal why merged onto the entry
    expect(kw.has("犬")).toBe(false);
    expect(keywordIndex(null).size).toBe(0);
  });

  it("triggers on a keyword or a ★ tap, not on ordinary lines", () => {
    const kw = keywordIndex(PREP);
    const dog: Cue = { start: 0, end: 2, tokens: [{ s: "犬", l: "犬", c: true }] };
    const park: Cue = { start: 2, end: 4, tokens: [{ s: "公園", l: "公園", c: true }] };
    expect(cueTriggered(park, kw, {})).toBe(true);
    expect(cueTriggered(dog, kw, {})).toBe(false);
    expect(cueTriggered(dog, kw, { 犬: "h" })).toBe(true);
    expect(cueTriggered(dog, kw, { 犬: "k" })).toBe(false);
    expect(cueTriggered({ start: 0, end: 2, text: "plain" }, kw, {})).toBe(false);
  });
});

describe("resume position", () => {
  it("round-trips and clears", () => {
    expect(getPosition("yt_x")).toBeNull();
    savePosition("yt_x", 123.4);
    expect(getPosition("yt_x")).toBeCloseTo(123.4);
    clearPosition("yt_x");
    expect(getPosition("yt_x")).toBeNull();
  });
});

describe("playerView subtitle overlay", () => {
  const EP = "yt_playertest";
  const TRANSCRIPT = {
    episode_id: EP,
    sentences: [
      {
        idx: 0,
        start: 0,
        end: 2,
        tokens: [
          { s: "犬", l: "犬", r: "いぬ", c: true, k: true },
          { s: "が", c: false },
        ],
      },
      { idx: 1, start: 2, end: 4, tokens: [{ s: "公園", l: "公園", r: "こうえん", c: true, k: false }] },
    ],
  };

  const DEFS = {
    犬: [{ k: ["犬"], r: ["いぬ"], s: [{ pos: ["noun"], g: ["dog"] }] }],
  };

  async function mount(): Promise<{ root: HTMLElement; video: HTMLVideoElement }> {
    saveSettings({ serverUrl: "http://pc.ts.net:8321", token: "tok" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/transcript/"))
          return new Response(JSON.stringify(TRANSCRIPT), { status: 200 });
        if (String(url).includes("/definitions/"))
          return new Response(JSON.stringify(DEFS), { status: 200 });
        return new Response("nope", { status: 404 });
      }),
    );
    const root = playerView(EP);
    document.body.appendChild(root);
    await new Promise((r) => setTimeout(r, 0)); // let the cue/defs fetches settle
    return { root, video: root.querySelector("video")! };
  }

  it("tapping any word opens the dictionary popup; marks cycle inside it", async () => {
    const { root, video } = await mount();
    video.dispatchEvent(new Event("timeupdate")); // currentTime 0 → first cue
    const w = root.querySelector<HTMLElement>(".subs-overlay .w[data-lemma]")!;
    expect(w).not.toBeNull();
    expect(w.dataset.lemma).toBe("犬");
    // particle rendered as plain text, not a tap target
    expect(root.querySelectorAll(".subs-overlay .w").length).toBe(1);

    w.click();
    const pop = root.querySelector<HTMLElement>(".gloss-pop")!;
    expect(pop.style.display).not.toBe("none");
    expect(pop.querySelector(".gp-sense")!.textContent).toContain("dog");
    expect(getTaps(EP)["犬"]).toBeUndefined(); // lookup is not a mark

    const mark = pop.querySelector<HTMLButtonElement>(".gp-mark")!;
    mark.click();
    expect(getTaps(EP)["犬"]).toBe("k");
    expect(w.classList.contains("tap-k")).toBe(true);
    mark.click();
    expect(getTaps(EP)["犬"]).toBe("h");
    root.remove();
  });

  it("clears the overlay in gaps between cues", async () => {
    const { root, video } = await mount();
    video.dispatchEvent(new Event("timeupdate"));
    expect(root.querySelector(".subs-overlay")!.textContent).not.toBe("");
    Object.defineProperty(video, "currentTime", { value: 99, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    expect(root.querySelector(".subs-overlay")!.textContent).toBe("");
    root.remove();
  });

  it("kw mode hides ordinary lines, shows keyword lines with orange highlight", async () => {
    localStorage.setItem("fp.sub.mode", "kw");
    cachePrep({ ...PREP, episode: { id: EP, title: "テスト" } });
    const { root, video } = await mount();
    video.dispatchEvent(new Event("timeupdate")); // t=0: 犬 line — no trigger
    expect(root.querySelector(".subs-overlay")!.textContent).toBe("");
    Object.defineProperty(video, "currentTime", { value: 2.5, configurable: true });
    video.dispatchEvent(new Event("timeupdate")); // 公園 line — keyword
    const w = root.querySelector<HTMLElement>(".subs-overlay .w[data-lemma='公園']")!;
    expect(w).not.toBeNull();
    expect(w.classList.contains("kw")).toBe(true);
    root.remove();
  });

  it("off mode shows nothing at all", async () => {
    localStorage.setItem("fp.sub.mode", "off");
    const { root, video } = await mount();
    video.dispatchEvent(new Event("timeupdate"));
    expect(root.querySelector(".subs-overlay")!.textContent).toBe("");
    root.remove();
  });

  it("tapping a keyword opens its gloss + note instead of cycling a mark", async () => {
    cachePrep({ ...PREP, episode: { id: EP, title: "テスト" } });
    const { root, video } = await mount();
    Object.defineProperty(video, "currentTime", { value: 2.5, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    root.querySelector<HTMLElement>(".subs-overlay .w[data-lemma='公園']")!.click();
    const pop = root.querySelector<HTMLElement>(".gloss-pop")!;
    expect(pop.style.display).not.toBe("none");
    expect(pop.querySelector(".gp-gloss")!.textContent).toBe("park");
    expect(pop.querySelector(".gp-note")!.textContent).toContain("公園へ行く");
    expect(pop.querySelector(".gp-why")!.textContent).toContain("散歩");
    expect(getTaps(EP)["公園"]).toBeUndefined(); // popup, not a mark cycle

    // marking happens through the popup's button
    const mark = pop.querySelector<HTMLButtonElement>(".gp-mark")!;
    mark.click();
    expect(getTaps(EP)["公園"]).toBe("k");
    mark.click();
    expect(getTaps(EP)["公園"]).toBe("h");
    root.remove();
  });
});
