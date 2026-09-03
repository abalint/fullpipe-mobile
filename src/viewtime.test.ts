// Immersion-time recording: calendar math (Sunday weeks), the recorder's
// accrual rules (rewinds count, seeks don't, speed folds out, midnight
// splits), crash recovery, the store/outbox round-trip, and the Progress
// tab's week → day → episode rendering.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  deleteViewSegment,
  deletedViewIds,
  getOpenViewSegment,
  getOutbox,
  getViewLog,
  hasPendingActions,
  mergeViewSegments,
  queueWatched,
  recordViewSegment,
  removeEpisodeActions,
  requeueViewSegments,
  saveSettings,
  setOpenViewSegment,
} from "./store";
import { flushOutbox } from "./sync";
import type { ViewSegment } from "./types";
import {
  ViewRecorder,
  addDays,
  completion,
  dayKey,
  fmtDur,
  groupWeeks,
  manualSegment,
  recoverOpenSegment,
  weekStart,
} from "./viewtime";
import { dayLabel, renderViewtime, splitLabel, weekLabel } from "./views/viewtime";
import { getViewGoal, saveViewGoal } from "./store";
import { goalStatus } from "./viewtime";

beforeEach(() => {
  localStorage.clear();
});

const seg = (over: Partial<ViewSegment>): ViewSegment => ({
  id: over.id ?? Math.random().toString(16).slice(2),
  episode_id: "ep1",
  title: "Episode One",
  kind: "watch",
  day: "2026-09-02",
  start: "2026-09-02T20:00:00.000Z",
  secs: 600,
  reached: 600,
  duration: 1800,
  ...over,
});

describe("calendar", () => {
  it("weeks start on Sunday and end on Saturday", () => {
    expect(weekStart("2026-09-02")).toBe("2026-08-30"); // Wednesday → the Sunday before
    expect(weekStart("2026-08-30")).toBe("2026-08-30"); // Sunday is its own start
    expect(weekStart("2026-09-05")).toBe("2026-08-30"); // Saturday closes the same week
    expect(weekStart("2026-09-06")).toBe("2026-09-06"); // next Sunday opens the next
    expect(addDays("2026-08-30", 6)).toBe("2026-09-05");
  });

  it("dayKey is device-local, zero-padded", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("formats durations", () => {
    expect(fmtDur(0)).toBe("0m");
    expect(fmtDur(20)).toBe("<1m");
    expect(fmtDur(59 * 60 + 40)).toBe("1h 00m");
    expect(fmtDur(12 * 60)).toBe("12m");
    expect(fmtDur(3900)).toBe("1h 05m");
  });
});

describe("ViewRecorder", () => {
  const opts = { episodeId: "ep1", title: "Episode One", kind: "watch" as const };

  /** Feed ticks every 0.25 media-seconds from `from` to `to`. */
  const play = (r: ViewRecorder, from: number, to: number, rate = 1, dur = 1800) => {
    for (let t = from; t <= to + 1e-9; t += 0.25) r.tick(t, rate, dur);
  };

  it("accrues wall-clock time from ordinary ticks and records the sitting", () => {
    const r = new ViewRecorder(opts);
    play(r, 0, 10);
    expect(r.current!.secs).toBeCloseTo(10, 5);
    expect(r.current!.reached).toBe(10);
    expect(r.current!.duration).toBe(1800);
    r.close();
    const log = getViewLog();
    expect(log.length).toBe(1);
    expect(log[0]).toMatchObject({ episode_id: "ep1", kind: "watch", secs: 10, reached: 10 });
    expect(log[0].day).toBe(dayKey());
    // and it's queued for the server
    expect(getOutbox().map((a) => a.kind)).toEqual(["viewtime"]);
    expect(r.current).toBeNull();
    expect(getOpenViewSegment()).toBeNull();
  });

  it("a rewind counts the rewatched stretch again; a seek counts nothing", () => {
    const r = new ViewRecorder(opts);
    play(r, 0, 10); // 10 s
    r.reanchor();
    play(r, 4, 10); // rewound to 4, watched 4→10 again: +6
    expect(r.current!.secs).toBeCloseTo(16, 5);
    r.reanchor();
    r.tick(900); // jumped ahead — the jump itself is free
    play(r, 900.25, 902); // +2 after the jump
    expect(r.current!.secs).toBeCloseTo(18, 5);
    expect(r.current!.reached).toBe(902);
    // even without reanchor(), a big jump between ticks is ignored
    r.tick(1700);
    expect(r.current!.secs).toBeCloseTo(18, 5);
  });

  it("folds playback speed out — 10 media-seconds at 2× is 5 s of your time", () => {
    const r = new ViewRecorder(opts);
    play(r, 0, 10, 2);
    expect(r.current!.secs).toBeCloseTo(5, 5);
  });

  it("opens lazily: an unplayed player records nothing", () => {
    const r = new ViewRecorder(opts);
    r.tick(0);
    r.tick(0); // paused — no advance
    r.close();
    expect(getViewLog()).toEqual([]);
    expect(getOutbox()).toEqual([]);
  });

  it("drops a sitting under one second", () => {
    const r = new ViewRecorder(opts);
    play(r, 0, 0.5);
    r.close();
    expect(getViewLog()).toEqual([]);
  });

  it("splits at midnight so each day gets its own seconds", () => {
    let now = new Date(2026, 8, 2, 23, 59, 55);
    const r = new ViewRecorder({ ...opts, now: () => now });
    play(r, 0, 5);
    now = new Date(2026, 8, 3, 0, 0, 1);
    play(r, 5.25, 15);
    r.close();
    const log = getViewLog();
    expect(log.map((s) => [s.day, s.secs])).toEqual([
      ["2026-09-02", 5],
      ["2026-09-03", 9.8], // the anchoring tick after the split isn't measured
    ]);
  });

  it("checkpoints the open segment and recovers it after a process death", () => {
    const r = new ViewRecorder(opts);
    play(r, 0, 7); // past the 5 s checkpoint bar
    const open = getOpenViewSegment();
    expect(open).not.toBeNull();
    expect(open!.secs).toBeGreaterThanOrEqual(5);
    // "the process died here" — a fresh start finds the slot and keeps it
    expect(recoverOpenSegment()).toBe(true);
    expect(getViewLog().length).toBe(1);
    expect(getOpenViewSegment()).toBeNull();
    expect(recoverOpenSegment()).toBe(false); // nothing left over
  });

  it("checkpoint() persists on demand (app backgrounded)", () => {
    const r = new ViewRecorder(opts);
    play(r, 0, 2);
    expect(getOpenViewSegment()).toBeNull();
    r.checkpoint();
    expect(getOpenViewSegment()!.secs).toBeCloseTo(2, 5);
  });
});

describe("store + sync", () => {
  it("recordViewSegment dedupes on id; mergeViewSegments never queues", () => {
    const a = seg({ id: "a" });
    expect(recordViewSegment(a)).toBe(true);
    expect(recordViewSegment(a)).toBe(false);
    expect(mergeViewSegments([a, seg({ id: "b" })])).toBe(1);
    expect(getViewLog().map((s) => s.id)).toEqual(["a", "b"]);
    expect(getOutbox().length).toBe(1); // only the recorded one
  });

  it("a deleted episode keeps its time entries but drops its workflow actions", () => {
    recordViewSegment(seg({ id: "a" }));
    queueWatched("ep1", true);
    expect(hasPendingActions("ep1")).toBe(true);
    removeEpisodeActions("ep1");
    expect(getOutbox().map((a) => a.kind)).toEqual(["viewtime"]);
    // time entries alone don't raise the row's pending-sync chip
    expect(hasPendingActions("ep1")).toBe(false);
  });

  it("flushes time entries to POST /viewtime", async () => {
    saveSettings({ serverUrl: "http://pc", token: "" });
    const s = seg({ id: "a" });
    recordViewSegment(s);
    const post = vi.spyOn(api, "postViewtime").mockResolvedValue({ id: "a", duplicate: false });
    const r = await flushOutbox();
    expect(post).toHaveBeenCalledWith(s);
    expect(r).toMatchObject({ sent: 1, remaining: 0 });
    vi.restoreAllMocks();
  });

  it("re-queues local sittings the server doesn't hold, skipping ones already pending", () => {
    recordViewSegment(seg({ id: "a" }));
    recordViewSegment(seg({ id: "b" }));
    mergeViewSegments([seg({ id: "c" })]); // came from the server — never re-sent
    // "a" was dropped from the outbox (404 from an old server); "b" still pending
    const [pendA] = getOutbox().filter((x) => x.kind === "viewtime" && x.segment.id === "a");
    getOutbox(); // noop read
    localStorage.setItem("fp.outbox", JSON.stringify(getOutbox().filter((x) => x.id !== pendA.id)));
    expect(requeueViewSegments(new Set(["c"]))).toBe(1);
    const ids = getOutbox().flatMap((x) => (x.kind === "viewtime" ? [x.segment.id] : []));
    expect(ids.sort()).toEqual(["a", "b"]);
    expect(requeueViewSegments(new Set(["a", "b", "c"]))).toBe(0);
  });

  it("deleting a manual entry tombstones it, withdraws its add, and queues the server delete", async () => {
    saveSettings({ serverUrl: "http://pc", token: "" });
    const m = manualSegment("2026-09-01", 30, "listen", "car radio");
    recordViewSegment(m);
    expect(deleteViewSegment(m.id)).toBe(true);
    expect(deleteViewSegment(m.id)).toBe(false);
    expect(getViewLog()).toEqual([]);
    expect(deletedViewIds()).toEqual([m.id]);
    expect(getOutbox().map((a) => a.kind)).toEqual(["viewtime_delete"]);
    // a server copy that hasn't caught up doesn't bring it back
    expect(mergeViewSegments([m])).toBe(0);
    const del = vi.spyOn(api, "deleteViewtime").mockResolvedValue({ id: m.id, deleted: true });
    await flushOutbox();
    expect(del).toHaveBeenCalledWith(m.id);
    vi.restoreAllMocks();
  });

  it("the open slot round-trips", () => {
    setOpenViewSegment(seg({ id: "o" }));
    expect(getOpenViewSegment()!.id).toBe("o");
    setOpenViewSegment(null);
    expect(getOpenViewSegment()).toBeNull();
  });
});

describe("groupWeeks", () => {
  it("weeks (Sun→Sat) → days → episodes, newest first, kinds kept apart", () => {
    const weeks = groupWeeks([
      seg({ id: "1", day: "2026-09-02", secs: 600, reached: 1790 }),
      seg({ id: "2", day: "2026-09-02", secs: 300, reached: 900, kind: "listen" }),
      seg({ id: "3", day: "2026-09-02", secs: 100, reached: 400 }), // same ep, same kind → merged
      seg({ id: "4", day: "2026-08-30", secs: 1200, episode_id: "ep2", title: "Two",
            reached: 500, duration: 2000 }),
      seg({ id: "5", day: "2026-08-29", secs: 60, episode_id: "ep3", title: "Three" }), // prior week
    ]);
    expect(weeks.map((w) => [w.start, w.end])).toEqual([
      ["2026-08-30", "2026-09-05"],
      ["2026-08-23", "2026-08-29"],
    ]);
    const [cur, prev] = weeks;
    expect(cur.watch).toBe(1900);
    expect(cur.listen).toBe(300);
    expect(cur.days.map((d) => d.day)).toEqual(["2026-09-02", "2026-08-30"]);
    const day = cur.days[0];
    expect(day.watch).toBe(700);
    expect(day.listen).toBe(300);
    expect(day.episodes.map((e) => [e.kind, e.secs, e.reached])).toEqual([
      ["watch", 700, 1790],
      ["listen", 300, 900],
    ]);
    expect(prev.days[0].episodes[0].title).toBe("Three");
  });

  it("completion: finished within the last 10 s, else the fraction reached", () => {
    expect(completion({ reached: 1790, duration: 1800 })).toBe(1);
    expect(completion({ reached: 1350, duration: 1800 })).toBeCloseTo(0.75);
    expect(completion({ reached: 100, duration: null })).toBeNull();
  });
});

describe("renderViewtime", () => {
  const today = "2026-09-02";

  it("labels", () => {
    expect(splitLabel(0, 0)).toBe("0m");
    expect(splitLabel(600, 0)).toBe("▶ 10m");
    expect(splitLabel(600, 120)).toBe("▶ 10m · 🎧 2m");
    expect(dayLabel("2026-09-02", today)).toMatch(/^Today · /);
    expect(dayLabel("2026-09-01", today)).toMatch(/^Yesterday · /);
    expect(dayLabel("2026-08-30", today)).not.toMatch(/Today|Yesterday/);
    const w = { start: "2026-08-30", end: "2026-09-05", watch: 0, listen: 0, days: [] };
    expect(weekLabel(w, today)).toMatch(/Aug 30 – Sep 5/);
    expect(weekLabel({ ...w, start: "2025-12-28", end: "2026-01-03" }, today)).toMatch(/2025/);
  });

  it("tiles + the current week open, earlier weeks collapsed, finished vs partial rows", () => {
    const root = document.createElement("div");
    renderViewtime(root, [
      seg({ id: "1", day: today, secs: 1500, reached: 1795 }),
      seg({ id: "2", day: today, secs: 300, kind: "listen", reached: 600, duration: null }),
      seg({ id: "3", day: "2026-08-31", secs: 900, episode_id: "ep2", title: "Two",
            reached: 1368, duration: 1800 }),
      seg({ id: "4", day: "2026-08-25", secs: 60, episode_id: "ep3", title: "Three" }),
    ], today);
    document.body.appendChild(root);
    const tiles = root.querySelectorAll(".stat-tile");
    expect(tiles.length).toBe(4);
    expect(tiles[0].textContent).toContain("30m"); // today: 25m + 5m
    expect(tiles[0].textContent).toContain("▶ 25m · 🎧 5m");
    expect(tiles[1].textContent).toContain("45m"); // this week: 25 + 5 + 15
    expect(tiles[2].textContent).toContain("41m"); // watched all time: 25 + 15 + 1
    expect(tiles[3].textContent).toContain("5m"); // listened all time

    const weeks = root.querySelectorAll<HTMLDetailsElement>("details.week");
    expect(weeks.length).toBe(2);
    expect(weeks[0].open).toBe(true);
    expect(weeks[1].open).toBe(false);
    expect(weeks[0].querySelector(".wk-range")!.textContent).toMatch(/Aug 30 – Sep 5/);
    expect(weeks[0].querySelector(".wk-tot")!.textContent).toBe("▶ 40m · 🎧 5m");

    const days = weeks[0].querySelectorAll(".day");
    expect(days.length).toBe(2);
    expect(days[0].querySelector(".day-name")!.textContent).toMatch(/^Today/);
    const rows = days[0].querySelectorAll(".ep-row");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".ep-kind")!.textContent).toBe("▶");
    expect(rows[0].querySelector(".ep-done")!.textContent).toBe("finished");
    expect(rows[1].querySelector(".ep-kind")!.textContent).toBe("🎧");
    expect(rows[1].querySelector(".ep-done")).toBeNull(); // length unknown
    // the unfinished episode says how far it got
    expect(days[1].querySelector(".ep-done")!.textContent).toBe("to 76%");
    expect(days[1].querySelector(".ep-title")!.textContent).toBe("Two");
    root.remove();
  });

  it("empty state", () => {
    const root = document.createElement("div");
    renderViewtime(root, [], today);
    expect(root.querySelectorAll("details.week").length).toBe(0);
    expect(root.textContent).toContain("Nothing recorded yet");
  });

  it("manual entries stay separate rows with ✕; imported rows fold by title; app rows by episode", () => {
    const a = manualSegment("2026-09-02", 30, "listen", "car radio");
    const b = manualSegment("2026-09-02", 15, "listen", "car radio");
    const weeks = groupWeeks([
      a, b,
      seg({ id: "i1", source: "import", episode_id: "import_listening", title: "Claymore (アニメ)", secs: 600, duration: null }),
      seg({ id: "i2", source: "import", episode_id: "import_listening", title: "Claymore (アニメ)", secs: 300, duration: null }),
      seg({ id: "i3", source: "import", episode_id: "import_listening", title: "Dragon Ball (アニメ)", secs: 100, duration: null }),
      seg({ id: "x1", secs: 100 }), seg({ id: "x2", secs: 100 }),
    ]);
    const rows = weeks[0].days[0].episodes;
    // longest first; ties keep insertion order (stable sort)
    expect(rows.map((r) => [r.source, r.title, r.secs, r.ids.length])).toEqual([
      ["manual", "car radio", 1800, 1],
      ["manual", "car radio", 900, 1],
      ["import", "Claymore (アニメ)", 900, 2],
      ["app", "Episode One", 200, 2],
      ["import", "Dragon Ball (アニメ)", 100, 1],
    ]);
    const onDelete = vi.fn();
    const root = document.createElement("div");
    renderViewtime(root, [a, seg({ id: "x1" })], today, { onDelete });
    const dels = root.querySelectorAll<HTMLButtonElement>(".ep-del");
    expect(dels.length).toBe(1); // only the manual row
    expect(root.querySelector(".ep-row.src-manual .ep-src")!.textContent).toBe("✎");
    // happy-dom has no confirm(); the row asks before removing
    const w = window as unknown as { confirm?: () => boolean };
    const orig = w.confirm;
    w.confirm = () => true;
    dels[0].click();
    expect(onDelete).toHaveBeenCalledWith(a.id);
    w.confirm = orig;
  });

  it("the add-time form saves a manual sitting for the chosen day and kind", () => {
    const onAdd = vi.fn();
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderViewtime(root, [], today, { onAdd });
    const form = root.querySelector<HTMLFormElement>(".addtime-form")!;
    expect(form.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>(".addtime-toggle")!.click();
    expect(form.hidden).toBe(false);
    const day = form.querySelector<HTMLInputElement>('input[type="date"]')!;
    expect(day.value).toBe(today);
    day.value = "2026-09-01";
    form.querySelector<HTMLInputElement>('input[type="number"]')!.value = "45";
    form.querySelector<HTMLInputElement>(".what")!.value = "podcast in the car";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    const seg1 = onAdd.mock.calls[0][0] as ViewSegment;
    expect(seg1).toMatchObject({
      source: "manual", kind: "listen", day: "2026-09-01", secs: 2700,
      title: "podcast in the car", episode_id: "manual", reached: 0, duration: null,
    });
    expect(form.hidden).toBe(true);
    // watching + default title
    root.querySelector<HTMLButtonElement>(".addtime-toggle")!.click();
    form.querySelector<HTMLButtonElement>('.kind .tag[data-kind="watch"]')!.click();
    form.querySelector<HTMLInputElement>('input[type="number"]')!.value = "10";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onAdd.mock.calls[1][0]).toMatchObject({ kind: "watch", secs: 600, title: "watching outside the app" });
    // nothing saved without minutes
    root.querySelector<HTMLButtonElement>(".addtime-toggle")!.click();
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onAdd).toHaveBeenCalledTimes(2);
    root.remove();
  });

  it("closed weeks build their day rows only when opened", () => {
    const root = document.createElement("div");
    renderViewtime(root, [
      seg({ id: "1", day: today }),
      seg({ id: "2", day: "2026-08-25", episode_id: "ep3", title: "Three" }),
    ], today);
    const weeks = root.querySelectorAll<HTMLDetailsElement>("details.week");
    expect(weeks[0].querySelectorAll(".day").length).toBe(1); // current week: eager
    expect(weeks[1].querySelectorAll(".day").length).toBe(0); // older: lazy
    weeks[1].open = true;
    weeks[1].dispatchEvent(new Event("toggle"));
    expect(weeks[1].querySelectorAll(".day").length).toBe(1);
    weeks[1].dispatchEvent(new Event("toggle")); // no double build
    expect(weeks[1].querySelectorAll(".day").length).toBe(1);
    root.remove();
  });

  it("goalStatus: left, open days counting today, even pace", () => {
    // Wednesday 2026-09-02: Wed..Sat = 4 open days
    let st = goalStatus(12 * 3600, 40, "2026-09-02");
    expect(st.leftSecs).toBe(28 * 3600);
    expect(st.openDays).toBe(4);
    expect(st.perDaySecs).toBe(7 * 3600);
    expect(st.met).toBe(false);
    expect(goalStatus(0, 40, "2026-08-30").openDays).toBe(7); // Sunday
    expect(goalStatus(0, 40, "2026-09-05").openDays).toBe(1); // Saturday
    st = goalStatus(41 * 3600, 40, "2026-09-02");
    expect(st.met).toBe(true);
    expect(st.leftSecs).toBe(0);
    expect(st.perDaySecs).toBe(0);
  });

  it("goal card: default 40h counts watching only, edits persist", () => {
    expect(getViewGoal()).toEqual({ hours: 40 });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const onGoalChanged = vi.fn();
    renderViewtime(root, [
      seg({ id: "1", day: today, secs: 10 * 3600 }),
      seg({ id: "2", day: today, secs: 2 * 3600, kind: "listen" }),
    ], today, { onGoalChanged });
    const card = root.querySelector(".goal")!;
    expect(card.querySelector(".goal-target")!.textContent).toBe("weekly goal 40h");
    expect(card.querySelector(".goal-done")!.textContent).toBe("10h 00m done · 30h 00m left");
    expect(card.querySelector(".goal-pace")!.textContent).toBe("4 days left counting today → 7h 30m a day");
    expect(card.querySelector<HTMLElement>(".freqfill")!.style.width).toBe("25%");
    expect(card.querySelector(".goal-note")!.textContent).toBe("active watching only");
    // edit: 30h
    const form = card.querySelector<HTMLFormElement>(".goal-form")!;
    expect(form.hidden).toBe(true);
    card.querySelector<HTMLButtonElement>(".goal-target")!.click();
    expect(form.hidden).toBe(false);
    form.querySelector<HTMLInputElement>('input[type="number"]')!.value = "30";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onGoalChanged).toHaveBeenCalled();
    expect(getViewGoal()).toEqual({ hours: 30 });
    root.remove();
    // repaint reads the saved goal; 12h of 30h; met once past it
    const again = document.createElement("div");
    renderViewtime(again, [seg({ id: "1", day: today, secs: 31 * 3600 })], today);
    expect(again.querySelector(".goal-target")!.textContent).toBe("weekly goal 30h");
    expect(again.querySelector(".goal-done")!.textContent).toBe("31h 00m · goal met ✓");
    expect(again.querySelector(".goal-pace")!.textContent).toMatch(/still open/);
    saveViewGoal({ hours: 0 }); // garbage → default
    expect(getViewGoal().hours).toBe(40);
  });

  it("folds weeks past the twelfth under 'earlier'", () => {
    const segs: ViewSegment[] = [];
    for (let i = 0; i < 15; i++)
      segs.push(seg({ id: String(i), day: addDays(today, -7 * i), secs: 60 }));
    const root = document.createElement("div");
    renderViewtime(root, segs, today);
    expect(root.querySelectorAll(".weeks > details.week").length).toBe(12);
    const more = root.querySelector<HTMLDetailsElement>("details.week-more")!;
    expect(more.querySelector("summary")!.textContent).toBe("3 earlier weeks");
    expect(more.querySelectorAll("details.week").length).toBe(3);
  });
});
