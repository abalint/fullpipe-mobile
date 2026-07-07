// Player logic tests: SRT parsing, cue lookup by time, the tokenized subtitle
// overlay's tap wiring (same store as the prep doc), and resume positions.
// Run: npx vitest run

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chunkIndexAt,
  chunkText,
  chunkTokens,
  cueIndexAt,
  cueTriggered,
  extendCues,
  getSubRise,
  getSubSize,
  getSubTier,
  isIplus1,
  keywordIndex,
  lastStartedAt,
  lineIndexAtTimes,
  lineStartTimes,
  parseSrt,
  playerView,
  setSubTier,
  soleUnknown,
  stepSubRise,
  stepSubSize,
  SUB_SIZES,
  SUB_RISE_MAX,
  textEms,
  tokenHighlight,
} from "./views/player";
import type { Cue, SubTier } from "./views/player";
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

  it("preserves the original ASR end as speechEnd for roll-up pacing", () => {
    const out = extendCues([{ start: 0, end: 2, text: "a" }]);
    expect(out[0].speechEnd).toBe(2);
    expect(out[0].end).toBe(4.5);
  });
});

describe("roll-up chunking", () => {
  const tok = (s: string, l?: string) => ({ s, l, c: !!l });

  it("textEms: CJK glyphs count full-width, ASCII half", () => {
    expect(textEms("公園")).toBe(2);
    expect(textEms("ab")).toBe(1);
    expect(textEms("公a")).toBe(1.5);
  });

  it("chunkTokens fills greedily and never splits a token", () => {
    const lines = chunkTokens([tok("あいう"), tok("えおか"), tok("きくけ")], 6.5);
    expect(lines.map((l) => l.map((t) => t.s).join(""))).toEqual(["あいうえおか", "きくけ"]);
  });

  it("chunkTokens lets closing punctuation overflow instead of orphaning", () => {
    expect(chunkTokens([tok("あいうえおか"), tok("。")], 6).length).toBe(1);
  });

  it("chunkTokens keeps a single oversized token whole", () => {
    expect(chunkTokens([tok("あいうえおかきく")], 3).length).toBe(1);
  });

  it("chunkText breaks at hard newlines and the width budget", () => {
    expect(chunkText("あいう\nえお", 10)).toEqual(["あいう", "えお"]);
    expect(chunkText("あいうえおかきくけこ", 4)).toEqual(["あいうえ", "おかきく", "けこ"]);
    expect(chunkText("あいうえ。", 4)).toEqual(["あいうえ。"]); // closer squeezes on
  });

  it("chunkIndexAt splits time by line weight across start→speechEnd", () => {
    const c: Cue = { start: 10, end: 22, speechEnd: 20 };
    const w = [1, 1, 2]; // boundaries at 12.5 and 15
    expect(chunkIndexAt(c, w, 10)).toBe(0);
    expect(chunkIndexAt(c, w, 12.4)).toBe(0);
    expect(chunkIndexAt(c, w, 12.6)).toBe(1);
    expect(chunkIndexAt(c, w, 15.1)).toBe(2);
  });

  it("chunkIndexAt holds the last line through the linger tail and clamps", () => {
    const c: Cue = { start: 10, end: 22, speechEnd: 20 };
    expect(chunkIndexAt(c, [1, 1], 21)).toBe(1); // lingering past speechEnd
    expect(chunkIndexAt(c, [1, 1], 9)).toBe(0); // before the start
    expect(chunkIndexAt(c, [1], 999)).toBe(0); // single line: always 0
  });

  it("lineStartTimes reads each line's first timed token, clamped + monotonic", () => {
    const c: Cue = { start: 10, end: 20 };
    const starts = lineStartTimes(c, [
      [tok("、"), { ...tok("あい", "あい"), t: 10.4 }], // untimed punct skipped
      [{ ...tok("うえ", "うえ"), t: 14 }],
      [{ ...tok("おか", "おか"), t: 13 }], // clock glitch → clamped to 14
    ]);
    expect(starts).toEqual([10, 14, 14]); // line 0 clamps to the cue start
  });

  it("lineStartTimes is null when any line has no timed token (fallback)", () => {
    const c: Cue = { start: 0, end: 5 };
    expect(lineStartTimes(c, [[{ ...tok("あ", "あ"), t: 0.5 }], [tok("い", "い")]])).toBeNull();
    expect(lineStartTimes(c, [[tok("あ", "あ")]])).toBeNull(); // hand-crafted subs
  });

  it("lineIndexAtTimes picks the last started line and holds the ends", () => {
    const starts = [10, 14, 17];
    expect(lineIndexAtTimes(starts, 9)).toBe(0); // before the cue: first line
    expect(lineIndexAtTimes(starts, 13.9)).toBe(0);
    expect(lineIndexAtTimes(starts, 14)).toBe(1);
    expect(lineIndexAtTimes(starts, 99)).toBe(2); // linger tail: last line
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

describe("subtitle prefs", () => {
  it("size steps through the ladder, clamps, persists", () => {
    expect(getSubSize()).toBe(1);
    expect(stepSubSize(1)).toBe(1.15);
    expect(getSubSize()).toBe(1.15);
    for (let i = 0; i < 20; i++) stepSubSize(1);
    expect(getSubSize()).toBe(SUB_SIZES[SUB_SIZES.length - 1]);
    for (let i = 0; i < 20; i++) stepSubSize(-1);
    expect(getSubSize()).toBe(SUB_SIZES[0]);
  });

  it("rise steps up and down within bounds", () => {
    expect(getSubRise()).toBe(0);
    expect(stepSubRise(-1)).toBe(0); // clamped at the bottom
    expect(stepSubRise(1)).toBe(1);
    for (let i = 0; i < 20; i++) stepSubRise(1);
    expect(getSubRise()).toBe(SUB_RISE_MAX);
  });

  it("tier defaults to learn, persists, rejects junk", () => {
    expect(getSubTier()).toBe("learn");
    setSubTier("focus");
    expect(getSubTier()).toBe("focus");
    localStorage.setItem("fp.sub.tier", "garbage");
    expect(getSubTier()).toBe("learn");
  });
});

describe("i+1 detection", () => {
  const iplus: Cue = {
    start: 0,
    end: 2,
    cls: "i_plus_1",
    tokens: [
      { s: "犬", l: "犬", c: true, k: true },
      { s: "公園", l: "公園", c: true, k: false },
    ],
  };

  it("finds the sole unknown content lemma", () => {
    expect(soleUnknown(iplus)).toBe("公園");
    expect(soleUnknown({ start: 0, end: 2, tokens: [{ s: "犬", l: "犬", c: true, k: true }] })).toBeNull();
    expect(
      soleUnknown({
        start: 0,
        end: 2,
        tokens: [
          { s: "公園", l: "公園", c: true, k: false },
          { s: "散歩", l: "散歩", c: true, k: false },
        ],
      }),
    ).toBeNull(); // two unknowns ≠ i+1
    expect(soleUnknown({ start: 0, end: 2, text: "plain" })).toBeNull();
  });

  it("trusts cls when present, falls back to sole-unknown without it", () => {
    expect(isIplus1(iplus)).toBe(true);
    expect(isIplus1({ ...iplus, cls: "reinforcement" })).toBe(false);
    expect(isIplus1({ ...iplus, cls: undefined })).toBe(true); // old sidecar
    expect(isIplus1({ start: 0, end: 2, cls: undefined, tokens: iplus.tokens!.slice(0, 1) })).toBe(false);
  });
});

describe("tokenHighlight", () => {
  const kw = keywordIndex(PREP); // has 公園
  const hv = new Set(["候補"]);
  const t = (over: Partial<{ s: string; l: string; c: boolean; k: boolean; f: number }>) => ({
    s: "x",
    l: "x",
    c: true,
    k: false,
    ...over,
  });
  const at = (tier: SubTier, tok: ReturnType<typeof t>, target: string | null = null, cls?: string) =>
    tokenHighlight(tok, tier, kw, hv, target, cls);

  it("off tier and non-content tokens get nothing", () => {
    expect(at("off", t({ l: "公園" }))).toBeNull();
    expect(at("all", t({ c: false }))).toBeNull();
  });

  it("focus: keywords, high-value, and the i+1 target only", () => {
    expect(at("focus", t({ l: "公園" }))).toBe("kw");
    expect(at("focus", t({ l: "候補" }))).toBe("hl-hv");
    expect(at("focus", t({ l: "新語" }), "新語", "i_plus_1")).toBe("hl-target");
    expect(at("focus", t({ l: "新語" }))).toBeNull(); // plain unknown waits for learn
    expect(at("focus", t({ l: "復習" }), "復習", "reinforcement")).toBeNull();
  });

  it("i+1 target outranks its own candidate row so the underline shows", () => {
    expect(at("focus", t({ l: "候補" }), "候補", "i_plus_1")).toBe("hl-target");
  });

  it("learn: + all unknowns and the reinforcement target", () => {
    expect(at("learn", t({ l: "新語" }))).toBe("hl-unk");
    expect(at("learn", t({ l: "復習" }), "復習", "reinforcement")).toBe("hl-lrn");
    expect(at("learn", t({ l: "既知", k: true, f: 500 }))).toBeNull(); // known stays silent
  });

  it("all: + corpus-tracked known words", () => {
    expect(at("all", t({ l: "既知", k: true, f: 500 }))).toBe("hl-corpus");
    expect(at("all", t({ l: "固有", k: true }))).toBeNull(); // known, not in corpus
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
    candidates: ["公園"],
    sentences: [
      {
        idx: 0,
        start: 0,
        end: 2,
        cls: "comprehensible",
        tokens: [
          { s: "犬", l: "犬", r: "いぬ", c: true, k: true, f: 40 },
          { s: "が", c: false },
        ],
      },
      {
        idx: 1,
        start: 2,
        end: 4,
        cls: "i_plus_1",
        tokens: [{ s: "公園", l: "公園", r: "こうえん", c: true, k: false, f: 120 }],
      },
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

  it("badges i+1 lines and underlines the target word", async () => {
    const { root, video } = await mount();
    Object.defineProperty(video, "currentTime", { value: 2.5, configurable: true });
    video.dispatchEvent(new Event("timeupdate")); // 公園 line — i+1, candidate
    expect(root.querySelector(".subs-overlay .iplus-badge")!.textContent).toBe("+1");
    const w = root.querySelector<HTMLElement>(".subs-overlay .w[data-lemma='公園']")!;
    expect(w.classList.contains("hl-target")).toBe(true); // target beats hl-hv
    root.remove();
  });

  it("tier off strips all highlighting and the badge; known words stay silent", async () => {
    setSubTier("off");
    const { root, video } = await mount();
    Object.defineProperty(video, "currentTime", { value: 2.5, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    expect(root.querySelector(".subs-overlay .iplus-badge")).toBeNull();
    const w = root.querySelector<HTMLElement>(".subs-overlay .w[data-lemma='公園']")!;
    expect(w.className).toBe("w unk"); // tokenSpan's classes only — no hl-*
    root.remove();
  });

  it("tier all tints known corpus words; learn leaves them plain", async () => {
    setSubTier("all");
    const { root, video } = await mount();
    video.dispatchEvent(new Event("timeupdate")); // 犬 line — known, rank 40
    const dog = root.querySelector<HTMLElement>(".subs-overlay .w[data-lemma='犬']")!;
    expect(dog.classList.contains("hl-corpus")).toBe(true);

    setSubTier("learn");
    Object.defineProperty(video, "currentTime", { value: 0.5, configurable: true });
    video.dispatchEvent(new Event("timeupdate")); // same cue index — force repaint
    Object.defineProperty(video, "currentTime", { value: 2.5, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    Object.defineProperty(video, "currentTime", { value: 0.5, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    const dog2 = root.querySelector<HTMLElement>(".subs-overlay .w[data-lemma='犬']")!;
    expect(dog2.classList.contains("hl-corpus")).toBe(false);
    root.remove();
  });

  it("Aa panel toggles, steps size/rise onto stage CSS vars, switches tier", async () => {
    const { root, video } = await mount();
    const stage = root.querySelector<HTMLElement>(".player-stage")!;
    expect(stage.style.getPropertyValue("--sub-scale")).toBe("1");
    expect(stage.style.getPropertyValue("--sub-rise")).toBe("0%");

    const subBtn = [...root.querySelectorAll<HTMLButtonElement>("button.pv")].find(
      (b) => b.textContent === "Aa",
    )!;
    const panel = root.querySelector<HTMLElement>(".sub-panel")!;
    expect(panel.style.display).toBe("none");
    subBtn.click();
    expect(panel.style.display).toBe("");

    const btns = [...panel.querySelectorAll<HTMLButtonElement>("button")];
    btns.find((b) => b.textContent === "A+")!.click();
    expect(stage.style.getPropertyValue("--sub-scale")).toBe("1.15");
    expect(getSubSize()).toBe(1.15);
    btns.find((b) => b.textContent === "▲")!.click();
    btns.find((b) => b.textContent === "▲")!.click();
    expect(stage.style.getPropertyValue("--sub-rise")).toBe("10%");
    expect(getSubRise()).toBe(2);

    // tier buttons repaint the current cue
    Object.defineProperty(video, "currentTime", { value: 2.5, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    expect(root.querySelector(".subs-overlay .hl-target")).not.toBeNull();
    btns.find((b) => b.textContent === "off")!.click();
    expect(getSubTier()).toBe("off");
    expect(root.querySelector(".subs-overlay .hl-target")).toBeNull();
    root.remove();
  });

  it("rolls a long cue through a 2-line window instead of painting it whole", async () => {
    // one 12s sentence of 9 ten-glyph words (90 ems) — at least 3 lines at any
    // plausible budget, so the overlay must window it rather than dump it
    const LONG = {
      episode_id: EP,
      candidates: [],
      sentences: [
        {
          idx: 0,
          start: 0,
          end: 12,
          cls: "comprehensible",
          tokens: Array.from({ length: 9 }, (_, i) => ({
            s: "あいうえおかきくけこ",
            l: `w${i}`,
            c: true,
            k: true,
          })),
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/transcript/")
          ? new Response(JSON.stringify(LONG), { status: 200 })
          : new Response("nope", { status: 404 }),
      ),
    );
    saveSettings({ serverUrl: "http://pc.ts.net:8321", token: "tok" });
    const root = playerView(EP);
    document.body.appendChild(root);
    await new Promise((r) => setTimeout(r, 0));
    const video = root.querySelector("video")!;
    const overlay = root.querySelector(".subs-overlay")!;

    Object.defineProperty(video, "currentTime", { value: 0.1, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    expect(overlay.querySelectorAll(".sub-line").length).toBe(1); // opening line alone
    expect(overlay.querySelector(".w[data-lemma='w0']")).not.toBeNull();
    expect(overlay.querySelector(".w[data-lemma='w8']")).toBeNull(); // tail not shown yet

    Object.defineProperty(video, "currentTime", { value: 11.9, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    const lines = overlay.querySelectorAll(".sub-line");
    expect(lines.length).toBe(2); // window: previous + current, never more
    expect(lines[0].classList.contains("prev")).toBe(true);
    expect(lines[1].querySelector(".w[data-lemma='w8']")).not.toBeNull();
    expect(overlay.querySelector(".w[data-lemma='w0']")).toBeNull(); // rolled out
    root.remove();
  });

  it("paces the roll-up on ASR-aligned token times when present", async () => {
    // 12s cue, but the speech is lopsided: first word at 0s, everything else
    // crammed at 11s (a long mid-sentence pause). Proportional pacing would
    // have rolled past line 0 by t=5; real times must hold it.
    const TIMED = {
      episode_id: EP,
      candidates: [],
      sentences: [
        {
          idx: 0,
          start: 0,
          end: 12,
          cls: "comprehensible",
          tokens: Array.from({ length: 9 }, (_, i) => ({
            s: "あいうえおかきくけこ",
            l: `w${i}`,
            c: true,
            k: true,
            t: i === 0 ? 0 : 11 + i * 0.01,
          })),
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/transcript/")
          ? new Response(JSON.stringify(TIMED), { status: 200 })
          : new Response("nope", { status: 404 }),
      ),
    );
    saveSettings({ serverUrl: "http://pc.ts.net:8321", token: "tok" });
    const root = playerView(EP);
    document.body.appendChild(root);
    await new Promise((r) => setTimeout(r, 0));
    const video = root.querySelector("video")!;
    const overlay = root.querySelector(".subs-overlay")!;

    Object.defineProperty(video, "currentTime", { value: 5, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    expect(overlay.querySelectorAll(".sub-line").length).toBe(1); // still line 0
    expect(overlay.querySelector(".w[data-lemma='w0']")).not.toBeNull();

    Object.defineProperty(video, "currentTime", { value: 11.5, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    const lines = overlay.querySelectorAll(".sub-line");
    expect(lines.length).toBe(2);
    expect(lines[1].querySelector(".w[data-lemma='w8']")).not.toBeNull();
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
