// ambience.ts: the remembered mix, its description, and the local-file
// index — the pure parts the panel and the strip paint from. The native
// service and the downloads are the phone's.

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MUSIC_VOLUME,
  describeMix,
  getMix,
  isLocal,
  localBytes,
  mixIsEmpty,
  moodLocal,
  saveMix,
} from "./ambience";
import type { AmbienceCatalog } from "./ambience";

const CAT: AmbienceCatalog = {
  built_at: "2026-10-08T00:00:00Z",
  sounds: [
    { id: "rain", title: "雨", emoji: "🌧", file: "sounds/rain.ogg", ms: 1_800_000, bytes: 14_000_000 },
    { id: "fire", title: "焚き火", emoji: "🔥", file: "sounds/fire.ogg", ms: 1_800_000, bytes: 14_000_000 },
  ],
  moods: [
    {
      id: "focus", title: "Lo-fi focus", emoji: "🎧",
      tracks: [
        { id: "a", title: "A", file: "music/focus/a.ogg", ms: 3_600_000, bytes: 40_000_000 },
        { id: "b", title: "B", file: "music/focus/b.ogg", ms: 3_600_000, bytes: 40_000_000 },
      ],
    },
  ],
};

beforeEach(() => localStorage.clear());

describe("the remembered mix", () => {
  it("starts empty with the default music volume", () => {
    const m = getMix();
    expect(m.layers).toEqual({});
    expect(m.mood).toBeNull();
    expect(m.musicVolume).toBe(DEFAULT_MUSIC_VOLUME);
    expect(mixIsEmpty(m)).toBe(true);
  });

  it("round-trips through localStorage", () => {
    saveMix({ layers: { rain: 0.4, fire: 0.7 }, mood: "focus", musicVolume: 0.3 });
    const m = getMix();
    expect(m.layers).toEqual({ rain: 0.4, fire: 0.7 });
    expect(m.mood).toBe("focus");
    expect(m.musicVolume).toBe(0.3);
    expect(mixIsEmpty(m)).toBe(false);
  });

  it("describes itself with the catalog's names, falling back to ids", () => {
    const m = { layers: { rain: 0.4, fire: 0.7 }, mood: "focus", musicVolume: 0.3 };
    expect(describeMix(m, CAT)).toBe("🌧 雨 · 🔥 焚き火 · 🎧 Lo-fi focus");
    expect(describeMix(m, null)).toBe("rain · fire · focus");
    expect(describeMix({ layers: {}, mood: null, musicVolume: 1 }, CAT)).toBe("");
  });
});

describe("the local-file index", () => {
  it("knows what's on the phone and how big it is", () => {
    expect(isLocal("sounds/rain.ogg")).toBe(false);
    localStorage.setItem("fp.ambience.local", JSON.stringify({ "sounds/rain.ogg": 14_000_000, "music/focus/a.ogg": 40_000_000 }));
    expect(isLocal("sounds/rain.ogg")).toBe(true);
    expect(localBytes()).toBe(54_000_000);
    expect(moodLocal(CAT.moods[0])).toEqual({ all: false, some: true, done: 1 });
    localStorage.setItem("fp.ambience.local", JSON.stringify({ "music/focus/a.ogg": 1, "music/focus/b.ogg": 1 }));
    expect(moodLocal(CAT.moods[0])).toEqual({ all: true, some: true, done: 2 });
    expect(moodLocal({ ...CAT.moods[0], tracks: [] })).toEqual({ all: false, some: false, done: 0 });
  });

  it("survives a corrupt entry", () => {
    localStorage.setItem("fp.ambience.local", "{nope");
    expect(isLocal("sounds/rain.ogg")).toBe(false);
    localStorage.setItem("fp.ambience.mix", "[");
    expect(mixIsEmpty(getMix())).toBe(true);
  });
});
