// The gloss popup's two layers: a tap inside a curated phrase opens the
// phrase as its own item (head, mark, senses) above the word card, and the
// two marks are independent.

import { beforeEach, describe, expect, it } from "vitest";
import { createGlossPopup } from "./gloss-popup";
import { phraseListsFor } from "./paint";
import { getLookups, getTaps, phraseTapKey } from "./store";
import type { Definitions, Token } from "./types";

beforeEach(() => localStorage.clear());

const tokens: Token[] = [
  { s: "元", l: "元" }, { s: "バレー", l: "バレー", c: 1 }, { s: "部", l: "部" },
  { s: "の", l: "の" }, { s: "血", l: "血", c: 1, k: 1 }, { s: "が", l: "が" },
  { s: "騒い", l: "騒ぐ", c: 1, k: 1 }, { s: "だ", l: "だ" },
];
const sentence = {
  tokens,
  phrases: [{ canonical: "血が騒ぐ", surface: "血が騒いだ", start: 4, end: 7, status: "unknown" as const },
            { canonical: "気を付ける", surface: "気を付けて" }],
};
const defs: Definitions = {
  "血": [{ k: ["血"], r: ["ち"], s: [{ pos: ["noun"], g: ["blood"] }] }],
  "バレー部": [{ k: ["バレー部"], r: ["バレーぶ"], s: [{ pos: ["noun"], g: ["volleyball club"] }] }],
  "血が騒ぐ": [{ k: ["血が騒ぐ"], r: ["ちがさわぐ"], s: [{ pos: ["expression"], g: ["to get excited"] }] }],
};

function popup(interest = new Set<string>()) {
  return createGlossPopup({
    episodeId: "ep1",
    defs: () => defs,
    phrases: () => ({ ...phraseListsFor(null), interest }),
  });
}

describe("gloss popup phrase layer", () => {
  it("a tap inside the span shows the phrase above the word, each with its own mark", () => {
    const pop = popup();
    pop.show("血", 4, sentence);
    const layers = [...pop.el.querySelectorAll(".gp-layer")].map((n) => n.className);
    expect(layers).toEqual(["gp-layer gp-phrase", "gp-layer gp-word"]);
    const phrase = pop.el.querySelector<HTMLElement>(".gp-phrase")!;
    expect(phrase.dataset.phrase).toBe("血が騒ぐ");
    expect(phrase.textContent).toContain("to get excited");
    expect(phrase.textContent).toContain("血が騒いだ"); // how it surfaces here
    const word = pop.el.querySelector(".gp-word")!;
    expect(word.textContent).toContain("blood");
    // the unplaced phrase on the same line stays a foot note, not a layer
    expect(word.querySelector(".gp-line-note")!.textContent).toContain("気を付ける");
    // marking the phrase leaves the word alone, and the other way round
    (phrase.querySelector(".gp-mark") as HTMLButtonElement).click();
    expect(getTaps("ep1")).toEqual({ [phraseTapKey("血が騒ぐ")]: "k" });
    (word.querySelector(".gp-mark") as HTMLButtonElement).click();
    expect(getTaps("ep1")).toEqual({ [phraseTapKey("血が騒ぐ")]: "k", "血": "k" });
    expect(phrase.querySelector(".gp-mark")!.textContent).toBe("known ✓");
  });

  it("a tap outside the span gets only the word layer", () => {
    const pop = popup();
    pop.show("の", 3, sentence);
    expect(pop.el.querySelector(".gp-phrase")).toBeNull();
    expect(pop.el.querySelector(".gp-word .gp-head .gp-tag")).toBeNull(); // no "word" tag needed
    // both phrases are still reachable as line notes
    expect(pop.el.querySelectorAll(".gp-line-note").length).toBe(2);
  });

  it("a dictionary compound the tap sits in is a phrase layer with its own mark", () => {
    // バレー|部 → バレー部 is a JMdict headword the server served; no curate
    // entry, yet it is a phrase key like any other (GRAMMAR.md)
    const pop = popup();
    pop.show("バレー", 1, sentence);
    const layer = pop.el.querySelector<HTMLElement>(".gp-phrase")!;
    expect(layer.dataset.phrase).toBe("バレー部");
    expect(layer.textContent).toContain("volleyball club");
    (layer.querySelector(".gp-mark") as HTMLButtonElement).click();
    expect(getTaps("ep1")).toEqual({ [phraseTapKey("バレー部")]: "k" });
    expect(pop.el.querySelector(".gp-compound")).toBeNull(); // the old read-only block is gone
  });

  it("nested dictionary compounds collapse to the widest match, dictionary form over surface", () => {
    // 安土|桃山|時代: the server served 安土桃山時代, 安土桃山 and 桃山時代 —
    // one expression seen at three widths; a tap on 桃山 opens ONE layer.
    // 歩き|始め(始める): surface key 歩き始め (noun) and dictionary-form key
    // 歩き始める (verb) both served for the same span — the verb is the word.
    const toks: Token[] = [
      { s: "安土", l: "安土", c: 1 }, { s: "桃山", l: "桃山", c: 1 }, { s: "時代", l: "時代", c: 1 },
      { s: "に", l: "に" }, { s: "歩き", l: "歩く", c: 1 }, { s: "始め", l: "始める", c: 1 },
      { s: "た", l: "た" },
    ];
    const d: Definitions = {
      "安土桃山時代": [{ k: ["安土桃山時代"], r: ["あづちももやまじだい"], s: [{ pos: ["noun"], g: ["Azuchi-Momoyama period"] }] }],
      "安土桃山": [{ k: ["安土桃山"], r: ["あづちももやま"], s: [{ pos: ["noun"], g: ["Azuchi-Momoyama"] }] }],
      "桃山時代": [{ k: ["桃山時代"], r: ["ももやまじだい"], s: [{ pos: ["noun"], g: ["Momoyama period"] }] }],
      "歩き始め": [{ k: ["歩き始め"], r: ["あるきはじめ"], s: [{ pos: ["noun"], g: ["starting to walk"] }] }],
      "歩き始める": [{ k: ["歩き始める"], r: ["あるきはじめる"], s: [{ pos: ["verb"], g: ["to begin to walk"] }] }],
    };
    const pop = createGlossPopup({ episodeId: "ep1", defs: () => d,
      phrases: () => phraseListsFor(null) });
    pop.show("桃山", 1, { tokens: toks });
    let layers = [...pop.el.querySelectorAll<HTMLElement>(".gp-phrase")].map((e) => e.dataset.phrase);
    expect(layers).toEqual(["安土桃山時代"]);
    pop.show("始める", 5, { tokens: toks });
    layers = [...pop.el.querySelectorAll<HTMLElement>(".gp-phrase")].map((e) => e.dataset.phrase);
    expect(layers).toEqual(["歩き始める"]);
    // a compound nested inside a curated phrase's span is that phrase, not a second layer
    pop.show("桃山", 1, { tokens: toks, phrases: [
      { canonical: "安土桃山時代", surface: "安土桃山時代", start: 0, end: 3, status: "unknown" as const }] });
    layers = [...pop.el.querySelectorAll<HTMLElement>(".gp-phrase")].map((e) => e.dataset.phrase);
    expect(layers).toEqual(["安土桃山時代"]);
  });

  it("a phrase the painter couldn't place (no span) is still markable from its foot note", () => {
    const pop = popup();
    pop.show("の", 3, { tokens, phrases: [{ canonical: "血が騒ぐ" }] });
    expect(pop.el.querySelector(".gp-phrase")).toBeNull(); // no layer without a span
    const note = pop.el.querySelector<HTMLElement>(".gp-line-phrase")!;
    (note.querySelector(".gp-mark") as HTMLButtonElement).click();
    expect(getTaps("ep1")).toEqual({ [phraseTapKey("血が騒ぐ")]: "k" });
  });

  it("the mark button cycles ✓ → ★ → ✗ → clear, on the phrase and the word alike", () => {
    const pop = popup();
    pop.show("血", 4, sentence);
    const btn = pop.el.querySelector(".gp-word .gp-mark") as HTMLButtonElement;
    const labels: string[] = [btn.textContent!];
    for (let i = 0; i < 4; i++) {
      btn.click();
      labels.push(btn.textContent!);
    }
    expect(labels).toEqual(["mark", "known ✓", "interest ★", "unknown ✗", "mark"]);
    expect(getTaps("ep1")).toEqual({});
    const pbtn = pop.el.querySelector(".gp-phrase .gp-mark") as HTMLButtonElement;
    pbtn.click(); pbtn.click(); pbtn.click();
    expect(pbtn.textContent).toBe("unknown ✗");
    expect(getTaps("ep1")).toEqual({ [phraseTapKey("血が騒ぐ")]: "u" });
  });

  it("a standing ★ on the phrase reads as interest until the phone marks it", () => {
    const pop = popup(new Set(["血が騒ぐ"]));
    pop.show("騒ぐ", 6, sentence);
    expect(pop.el.querySelector(".gp-phrase .gp-mark")!.textContent).toBe("interest ★");
    expect(pop.el.querySelector(".gp-word .gp-mark")!.textContent).toBe("mark");
  });
});

describe("lookups", () => {
  beforeEach(() => localStorage.clear());

  it("counts every open with what the word was painted as, and never marks", () => {
    const pop = createGlossPopup({
      episodeId: "ep1",
      defs: () => ({}),
      listOf: (lemma) => (lemma === "犬" ? "confirm" : "none"),
    });
    pop.show("犬");
    pop.show("犬");
    pop.show("猫");
    expect(getLookups("ep1")).toEqual({
      犬: { n: 2, lists: { confirm: 2 } },
      猫: { n: 1, lists: { none: 1 } },
    });
    expect(getTaps("ep1")).toEqual({});
  });
});

describe("gloss popup grammar layer", () => {
  it("shows the unit the tap sits in and none of the line's other units", () => {
    const pop = popup();
    const line = {
      ...sentence,
      grammar: [
        { pattern: "〜を", start: 1, end: 2 },
        { pattern: "〜が", start: 2, end: 3 },
        { pattern: "〜たら", start: 4, end: 5 },
      ],
    };
    pop.show("血", 4, line);
    const layers = [...pop.el.querySelectorAll(".gp-layer")].map((n) => n.className);
    expect(layers).toContain("gp-layer gp-grammar");
    expect(pop.el.querySelector<HTMLElement>(".gp-grammar")!.dataset.grammar).toBe("〜たら");
    // bare particles elsewhere on the line never ride along under this word
    expect(pop.el.querySelectorAll(".gp-line-grammar").length).toBe(0);
    expect(pop.el.textContent).not.toContain("〜が");
    expect(pop.el.textContent).not.toContain("〜を");
    // a tap on a token no unit covers gets no grammar layer at all
    pop.show("の", 3, line);
    expect(pop.el.querySelector(".gp-grammar")).toBeNull();
    expect(pop.el.querySelectorAll(".gp-line-grammar").length).toBe(0);
  });
});
