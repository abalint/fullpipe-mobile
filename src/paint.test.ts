// Live paint overlay: known-tap union across episodes, in-place token
// flips, list precedence (live state over sidecar snapshot), the cache, and
// the player's grammar-confirm cue helper.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { cycleTap } from "./store";
import type { PaintState, TranscriptDoc } from "./types";
import {
  applyKnown,
  cachePaint,
  confirmFrom,
  fetchPaint,
  getCachedPaint,
  knownFor,
  locallyKnown,
} from "./paint";
import { cueGrammarConfirm } from "./views/player";

beforeEach(() => localStorage.clear());

const state = (over: Partial<PaintState> = {}): PaintState => ({
  episode_id: "ep2", known: [], confirm: [], interest: [], grammar_confirm: [],
  at: "2026-09-02T00:00:00Z", ...over,
});

describe("paint", () => {
  it("a ✓ tapped in any episode counts as known everywhere", () => {
    cycleTap("ep1", "盗む"); // k
    cycleTap("ep1", "流れ"); // k
    cycleTap("ep1", "流れ"); // → h (want to learn, not known)
    cycleTap("ep3", "先ほど"); // k
    expect(locallyKnown()).toEqual(new Set(["盗む", "先ほど"]));
    const k = knownFor(state({ known: ["以下"] }));
    expect(k).toEqual(new Set(["盗む", "先ほど", "以下"]));
  });

  it("applyKnown flips only unknown content tokens with a matching lemma", () => {
    const sentences = [
      { tokens: [{ s: "盗む", l: "盗む", c: true, k: false }, { s: "を", l: "を", k: true }] },
      { tokens: [{ s: "犬", l: "犬", c: true, k: false }] },
    ];
    expect(applyKnown(sentences, new Set(["盗む", "を"]))).toBe(1);
    expect(sentences[0].tokens[0].k).toBe(true);
    expect(sentences[1].tokens[0].k).toBe(false);
    expect(applyKnown(sentences, new Set(["盗む"]))).toBe(0); // idempotent
  });

  it("the live list wins over the sidecar snapshot; snapshot is the fallback", () => {
    const doc = { episode_id: "ep2", confirm: ["古い"], sentences: [] } as unknown as TranscriptDoc;
    expect(confirmFrom(state({ confirm: ["新しい"] }), doc)).toEqual(new Set(["新しい"]));
    expect(confirmFrom(null, doc)).toEqual(new Set(["古い"]));
    expect(confirmFrom(null, null).size).toBe(0);
  });

  it("fetchPaint caches on success and keeps the cache on failure", async () => {
    vi.spyOn(api, "getPaint").mockResolvedValueOnce(state({ known: ["a"] }));
    expect((await fetchPaint("ep2"))!.known).toEqual(["a"]);
    expect(getCachedPaint("ep2")!.known).toEqual(["a"]);
    vi.spyOn(api, "getPaint").mockRejectedValueOnce(new Error("offline"));
    expect(await fetchPaint("ep2")).toBeNull();
    expect(getCachedPaint("ep2")!.known).toEqual(["a"]);
    cachePaint("ep2", state({ known: ["b"] }));
    expect(getCachedPaint("ep2")!.known).toEqual(["b"]);
    vi.restoreAllMocks();
  });

  it("cueGrammarConfirm picks the cue's patterns that sit in the queue", () => {
    const cue = { start: 0, end: 1, grammar: [{ pattern: "〜てしまう" }, { pattern: "〜ながら" }] };
    expect(cueGrammarConfirm(cue, new Set(["〜ながら", "〜ておく"]))).toEqual(["〜ながら"]);
    expect(cueGrammarConfirm({ start: 0, end: 1 }, new Set(["〜ながら"]))).toEqual([]);
  });
});
