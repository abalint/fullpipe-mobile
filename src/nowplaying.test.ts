import { beforeEach, describe, expect, it, vi } from "vitest";

// the native plugin is absent under vitest — a controllable stand-in
const listeners: ((s: unknown) => void)[] = [];
let state: Record<string, unknown> = { running: false, playing: false, index: -1 };
vi.mock("./audio", () => ({
  PassiveAudio: {
    getState: () => Promise.resolve(state),
    addListener: (_: string, fn: (s: unknown) => void) => {
      listeners.push(fn);
      return Promise.resolve({ remove: () => {} });
    },
    toggle: vi.fn(() => Promise.resolve()),
  },
}));

import { nowPlayingStrip, nowPlayingVisible } from "./nowplaying";
import { PassiveAudio } from "./audio";

const playing = { running: true, playing: true, index: 0, episodeId: "ep1", positionMs: 65000, durationMs: 600000 };

describe("nowPlayingVisible", () => {
  it("shows on other tabs only while something is playing", () => {
    expect(nowPlayingVisible({ running: false, playing: false, index: -1 }, "#/queue")).toBe(false);
    expect(nowPlayingVisible(playing, "#/queue")).toBe(true);
    expect(nowPlayingVisible(playing, "#/progress")).toBe(true);
    expect(nowPlayingVisible(playing, "")).toBe(true);
  });
  it("hides where the episode is already on screen", () => {
    expect(nowPlayingVisible(playing, "#/listen")).toBe(false);
    expect(nowPlayingVisible(playing, "#/player/ep1")).toBe(false);
    expect(nowPlayingVisible(playing, "#/player/ep1/42")).toBe(false);
    expect(nowPlayingVisible(playing, "#/player/other")).toBe(true);
  });
});

describe("nowPlayingStrip", () => {
  beforeEach(() => {
    listeners.length = 0;
    location.hash = "#/queue";
  });

  it("names the playing episode, links to its player, and toggles pause", async () => {
    state = playing;
    const bar = nowPlayingStrip((ep) => (ep === "ep1" ? "犬の散歩" : undefined));
    await Promise.resolve(); // getState settles
    await Promise.resolve();
    expect(bar.hidden).toBe(false);
    const link = bar.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/player/ep1");
    expect(link.textContent).toContain("犬の散歩");
    expect(link.textContent).toContain("1:05 / 10:00");
    const btn = bar.querySelector("button")!;
    expect(btn.textContent).toBe("⏸");
    btn.click();
    expect(PassiveAudio.toggle).toHaveBeenCalled();
    // a state tick from the service repaints; stopping hides it
    listeners.forEach((fn) => fn({ ...playing, playing: false }));
    expect(btn.textContent).toBe("▶");
    listeners.forEach((fn) => fn({ running: false, playing: false, index: -1 }));
    expect(bar.hidden).toBe(true);
  });

  it("falls back to the episode id without a cached title", async () => {
    state = playing;
    const bar = nowPlayingStrip(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(bar.querySelector(".np-title")!.textContent).toBe("ep1");
  });
});
