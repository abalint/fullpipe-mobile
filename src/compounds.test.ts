// Compound key construction around a tapped token — must mirror the
// server's run rules (tools/jmdict.py compound_entries) exactly.
// Run: npx vitest run

import { describe, expect, it } from "vitest";
import { compoundKeysAt } from "./compounds";
import type { Token } from "./types";

const tok = (s: string, l = s): Token => ({ s, l, c: false, k: true });

describe("compoundKeysAt", () => {
  it("builds the joined key for a split compound (帝王|切開)", () => {
    const tokens = [tok("帝王"), tok("切開"), tok("の"), tok("話")];
    expect(compoundKeysAt(tokens, 0)).toContain("帝王切開");
    expect(compoundKeysAt(tokens, 1)).toContain("帝王切開"); // either half answers
  });

  it("adds a dictionary-form variant for an inflected tail (気を付けて)", () => {
    const tokens = [tok("気"), tok("を"), tok("付け", "付ける"), tok("て")];
    const keys = compoundKeysAt(tokens, 2);
    expect(keys).toContain("気を付け"); // surface concat
    expect(keys).toContain("気を付ける"); // surfaces + final lemma
  });

  it("orders longer runs first (widest match wins the popup slot)", () => {
    const tokens = [tok("そう"), tok("いう"), tok("こと")];
    const keys = compoundKeysAt(tokens, 1);
    expect(keys.indexOf("そういうこと")).toBeLessThan(keys.indexOf("そういう"));
  });

  it("does not cross punctuation or lemma-less tokens", () => {
    const tokens = [tok("話"), tok("。"), tok("次")];
    expect(compoundKeysAt(tokens, 0)).toEqual([]);
    expect(compoundKeysAt(tokens, 1)).toEqual([]); // punctuation tap
  });

  it("handles edges without reading out of bounds", () => {
    expect(compoundKeysAt([tok("犬")], 0)).toEqual([]);
    expect(compoundKeysAt([], 0)).toEqual([]);
  });
});
