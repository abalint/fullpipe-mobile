// The gloss popup's two layers: a tap inside a curated phrase opens the
// phrase as its own item (head, mark, senses) above the word card, and the
// two marks are independent.

import { beforeEach, describe, expect, it } from "vitest";
import { createGlossPopup } from "./gloss-popup";
import { phraseListsFor } from "./paint";
import { getTaps, phraseTapKey } from "./store";
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
