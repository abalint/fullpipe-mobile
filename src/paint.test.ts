// Live paint overlay: known-tap union across episodes, in-place token
// flips, list precedence (live state over sidecar snapshot), the cache, and
// the player's grammar-confirm cue helper.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { clearTaps, cycleTap } from "./store";
import type { PaintState, TranscriptDoc } from "./types";
import {
  applyKnown,
  cachePaint,
  confirmFrom,
  fetchPaint,
  getCachedPaint,
  interestFor,
  knownFor,
  listClass,
  listsFor,
  locallyInterest,
  locallyKnown,
  paintsInterest,
  sameLists,
  shouldKnowFor,
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

  it("a ★ tapped in any episode paints purple everywhere; a ✓ anywhere ends it", () => {
    cycleTap("ep1", "流れ");
    cycleTap("ep1", "流れ"); // → h in ep1
    cycleTap("ep3", "先ほど"); // k in ep3
    expect(locallyInterest()).toEqual(new Set(["流れ"]));
    // server list + local ★, minus anything ✓'d on this phone
    const i = interestFor(state({ interest: ["以下", "先ほど"] }), null);
    expect(i).toEqual(new Set(["流れ", "以下"]));
    // no live state → the sidecar snapshot is the standing list
    expect(interestFor(null, { interest: ["古い"] })).toEqual(new Set(["流れ", "古い"]));
    expect(interestFor(null, null)).toEqual(new Set(["流れ"]));
  });

  it("a ★ survives the episode's close-out (tap store cleared) — offline, the journal keeps it", () => {
    cycleTap("ep1", "流れ");
    cycleTap("ep1", "流れ"); // → h
    clearTaps("ep1"); // Mark watched wipes the per-episode store
    expect(locallyInterest()).toEqual(new Set(["流れ"]));
    expect(interestFor(null, null)).toEqual(new Set(["流れ"]));
    // a ✓ in a later show ends it; cycling all the way back withdraws it
    cycleTap("ep2", "流れ"); // k
    expect(locallyInterest().size).toBe(0);
    expect(locallyKnown()).toEqual(new Set(["流れ"]));
    cycleTap("ep2", "流れ"); // h
    cycleTap("ep2", "流れ"); // cleared
    expect(locallyInterest().size).toBe(0);
    expect(locallyKnown().size).toBe(0);
  });

  it("a ★ that graduated to blue (or known) on the ledger no longer paints purple", () => {
    cycleTap("ep1", "以下");
    cycleTap("ep1", "以下"); // h, stale — the server has since promoted it
    expect(interestFor(state({ confirm: ["以下"] }), null).has("以下")).toBe(false);
    expect(interestFor(state({ known: ["以下"] }), null).has("以下")).toBe(false);
    expect(interestFor(null, { confirm: ["以下"] }).has("以下")).toBe(false);
    expect(interestFor(state(), null).has("以下")).toBe(true);
  });

  it("should-know is the server's window minus this phone's ✓ and ★", () => {
    cycleTap("ep1", "貸す"); // k
    cycleTap("ep1", "代わり");
    cycleTap("ep1", "代わり"); // h
    const sk = shouldKnowFor(state({ should_know: ["貸す", "代わり", "元"] }), null);
    expect(sk).toEqual(new Set(["元"]));
    expect(shouldKnowFor(null, { should_know: ["身"] })).toEqual(new Set(["身"]));
    expect(shouldKnowFor(null, null).size).toBe(0);
  });

  it("listClass ranks blue over purple over green; sameLists compares all three", () => {
    const lists = listsFor(
      state({ confirm: ["a", "b"], interest: ["b", "c"], should_know: ["c", "d"] }),
      null,
    );
    expect(listClass("a", lists)).toBe("hl-know");
    expect(listClass("b", lists)).toBe("hl-know");
    expect(listClass("c", lists)).toBe("hl-int");
    expect(listClass("d", lists)).toBe("hl-sk");
    expect(listClass("e", lists)).toBeNull();
    expect(listClass(undefined, lists)).toBeNull();
    expect(sameLists(lists, listsFor(state({ confirm: ["a", "b"], interest: ["b", "c"], should_know: ["c", "d"] }), null))).toBe(true);
    expect(sameLists(lists, listsFor(state({ confirm: ["a"], interest: ["b", "c"], should_know: ["c", "d"] }), null))).toBe(false);
  });

  it("paintsInterest: a local ★, or standing interest with no local mark — ✓ wins", () => {
    const standing = new Set(["以下"]);
    expect(paintsInterest("h", "x", standing)).toBe(true);
    expect(paintsInterest(undefined, "以下", standing)).toBe(true);
    expect(paintsInterest("k", "以下", standing)).toBe(false);
    expect(paintsInterest(undefined, "x", standing)).toBe(false);
    expect(paintsInterest(undefined, undefined, standing)).toBe(false);
  });

  it("cueGrammarConfirm picks the cue's patterns that sit in the queue", () => {
    const cue = { start: 0, end: 1, grammar: [{ pattern: "〜てしまう" }, { pattern: "〜ながら" }] };
    expect(cueGrammarConfirm(cue, new Set(["〜ながら", "〜ておく"]))).toEqual(["〜ながら"]);
    expect(cueGrammarConfirm({ start: 0, end: 1 }, new Set(["〜ながら"]))).toEqual([]);
  });
});
