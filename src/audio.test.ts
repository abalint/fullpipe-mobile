// Passive-player queue memory: where "play all" starts.
// Run: npx vitest run

import { describe, expect, it } from "vitest";
import { resolveStartIndex } from "./audio";
import type { PassiveTrack } from "./audio";

const track = (episodeId: string): PassiveTrack => ({
  src: `file:///videos/${episodeId}.mp4`,
  title: episodeId,
  episodeId,
});

describe("resolveStartIndex", () => {
  const items = [track("yt_a"), track("yt_b"), track("yt_c")];

  it("starts at the top with no memory", () => {
    expect(resolveStartIndex(items)).toBe(0);
  });

  it("resumes at the remembered episode", () => {
    expect(resolveStartIndex(items, undefined, "yt_b")).toBe(1);
  });

  it("an explicitly tapped episode beats the memory", () => {
    expect(resolveStartIndex(items, "yt_c", "yt_b")).toBe(2);
  });

  it("falls back to the top when the remembered episode is gone", () => {
    expect(resolveStartIndex(items, undefined, "yt_deleted")).toBe(0);
    expect(resolveStartIndex([], undefined, "yt_b")).toBe(0);
  });
});
