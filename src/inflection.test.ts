// Inflection-chain breakdown for the word popup: reassemble the conjugated
// span around a tapped token and label each auxiliary link.
// Run: npx vitest run

import { describe, expect, it } from "vitest";
import { inflectionAt } from "./inflection";
import type { Token } from "./types";

const tok = (s: string, l = s): Token => ({ s, l, c: false, k: true });

describe("inflectionAt", () => {
  it("labels a contracted progressive (抜いてる)", () => {
    const tokens = [tok("胃"), tok("を"), tok("抜い", "抜く"), tok("てる"), tok("時")];
    const infl = inflectionAt(tokens, 2)!;
    expect(infl.surface).toBe("抜いてる");
    expect(infl.lemma).toBe("抜く");
    expect(infl.parts.map((p) => p.text)).toEqual(["抜く", "てる"]);
    expect(infl.parts[1].label).toContain("ている");
  });

  it("walks a passive-past chain and labels each link (行かれた)", () => {
    const tokens = [tok("行か", "行く"), tok("れ", "れる"), tok("た")];
    const infl = inflectionAt(tokens, 0)!;
    expect(infl.surface).toBe("行かれた");
    expect(infl.parts.map((p) => p.text)).toEqual(["行く", "れ", "た"]);
    expect(infl.parts[1].label).toContain("done TO");
    expect(infl.parts[2].label).toContain("past");
  });

  it("answers the same from a mid-chain tap (the た of 行かれた)", () => {
    const tokens = [tok("行か", "行く"), tok("れ", "れる"), tok("た")];
    expect(inflectionAt(tokens, 2)?.surface).toBe("行かれた");
  });

  it("includes aux-position verbs only after て (てくれる vs main-verb くれる)", () => {
    const aux = [tok("見", "見る"), tok("て"), tok("くれ", "くれる"), tok("た")];
    expect(inflectionAt(aux, 0)?.surface).toBe("見てくれた");
    const main = [tok("ジャガイモ"), tok("くれ", "くれる"), tok("た")];
    expect(inflectionAt(main, 0)).toBeNull(); // noun doesn't chain
    expect(inflectionAt(main, 1)?.surface).toBe("くれた"); // the verb itself does
  });

  it("relabels たら as 'if', not past", () => {
    const tokens = [tok("食べ", "食べる"), tok("たら", "た")];
    expect(inflectionAt(tokens, 0)?.parts[1].label).toContain("if");
  });

  it("does not glue a noun to a following particle で", () => {
    const tokens = [tok("パン"), tok("で"), tok("作る")];
    expect(inflectionAt(tokens, 0)).toBeNull();
    // …but keeps a genuine voiced te-form (泳いで)
    expect(inflectionAt([tok("泳い", "泳ぐ"), tok("で")], 0)?.surface).toBe("泳いで");
  });

  it("explains a bare inflected head with no chain (dictionary form only)", () => {
    const infl = inflectionAt([tok("言っ", "言う"), tok("。")], 0)!;
    expect(infl.surface).toBe("言っ");
    expect(infl.parts).toEqual([{ text: "言う" }]);
  });

  it("returns null when there is nothing to explain", () => {
    expect(inflectionAt([tok("美術館")], 0)).toBeNull(); // uninflected noun
    expect(inflectionAt([tok("て")], 0)).toBeNull(); // chain with no head
    expect(inflectionAt([], 0)).toBeNull();
  });

  it("handles a causative-passive pileup (食べさせられた)", () => {
    const tokens = [tok("食べ", "食べる"), tok("させ", "させる"), tok("られ", "られる"), tok("た")];
    const infl = inflectionAt(tokens, 0)!;
    expect(infl.surface).toBe("食べさせられた");
    expect(infl.parts.length).toBe(4);
  });
});
