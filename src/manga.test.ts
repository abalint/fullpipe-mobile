import { beforeEach, describe, expect, it } from "vitest";
import { continuousScroll, MAX_PAGE_SECS, ReadRecorder, readingMode, setContinuousScroll, setReadingMode } from "./manga";
import { getOpenViewSegment, getOutbox, getViewLog } from "./store";

beforeEach(() => localStorage.clear());

/** A clock the test advances by hand. */
function clock(startIso: string) {
  let t = new Date(startIso).getTime();
  return { now: () => new Date(t), advance: (secs: number) => (t += secs * 1000) };
}

describe("ReadRecorder", () => {
  it("turns pages read into a sitting with page-span ranges", () => {
    const c = clock("2026-09-14T10:00:00Z");
    const r = new ReadRecorder({ episodeId: "manga_x_v01", title: "X Vol. 1", pageSecs: 30,
      pageCount: 10, now: c.now });
    r.show(0);
    c.advance(20);
    r.show(1);
    c.advance(45);
    r.show(2);
    c.advance(0.4); // flicked past — noise
    r.show(3);
    c.advance(12);
    expect(getOpenViewSegment()?.secs).toBeCloseTo(65); // checkpointed as pages settle
    r.close();
    const log = getViewLog();
    expect(log).toHaveLength(1);
    const seg = log[0];
    expect(seg.kind).toBe("read");
    expect(seg.episode_id).toBe("manga_x_v01");
    expect(seg.secs).toBeCloseTo(77);
    expect(seg.duration).toBe(300);
    expect(seg.reached).toBe(120); // page 4's end
    // pages 0-1 merge into one span; page 2 was noise; page 3 is its own span
    expect(seg.played).toEqual([[0, 60], [90, 120]]);
    expect(getOutbox().some((a) => a.kind === "viewtime")).toBe(true);
    expect(getOpenViewSegment()).toBeNull();
  });

  it("caps a page left open and pauses in the background", () => {
    const c = clock("2026-09-14T10:00:00Z");
    const r = new ReadRecorder({ episodeId: "m", title: "m", pageSecs: 30, pageCount: 3, now: c.now });
    r.show(0);
    c.advance(2000);
    r.pause();
    c.advance(5000); // away — not counted
    r.resume();
    c.advance(10);
    r.close();
    expect(getViewLog()[0].secs).toBe(MAX_PAGE_SECS);
  });

  it("records nothing for a glance", () => {
    const c = clock("2026-09-14T10:00:00Z");
    const r = new ReadRecorder({ episodeId: "m", title: "m", pageSecs: 30, pageCount: 3, now: c.now });
    r.show(0);
    c.advance(0.5);
    r.close();
    expect(getViewLog()).toHaveLength(0);
  });

  it("a revisited page counts again", () => {
    const c = clock("2026-09-14T10:00:00Z");
    const r = new ReadRecorder({ episodeId: "m", title: "m", pageSecs: 30, pageCount: 3, now: c.now });
    r.show(1);
    c.advance(5);
    r.show(0);
    c.advance(5);
    r.show(1);
    c.advance(5);
    r.close();
    // page 1 alone, then the 0→1 run: page 1's start lies in both → seen twice
    expect(getViewLog()[0].played).toEqual([[30, 60], [0, 60]]);
  });
});

describe("reading mode / continuous scroll", () => {
  it("falls back to the volume's order, then remembers per series and as the default", () => {
    expect(readingMode("dandadan")).toBe("rtl");
    expect(readingMode("webtoon", "ltr")).toBe("ltr");
    setReadingMode("dandadan", "vertical");
    expect(readingMode("dandadan")).toBe("vertical");
    // comicReader: a change in the reader is also the new default for other series…
    expect(readingMode("other", "ltr")).toBe("vertical");
    // …but a series' own choice wins
    setReadingMode("other", "ltr");
    expect(readingMode("other")).toBe("ltr");
    expect(readingMode("dandadan")).toBe("vertical");
  });
  it("continuous scrolling is off until chosen, then remembered the same way", () => {
    expect(continuousScroll("dandadan")).toBe(false);
    setContinuousScroll("dandadan", true);
    expect(continuousScroll("dandadan")).toBe(true);
    expect(continuousScroll("other")).toBe(true);
    setContinuousScroll("other", false);
    expect(continuousScroll("other")).toBe(false);
    expect(continuousScroll("dandadan")).toBe(true);
  });
});
