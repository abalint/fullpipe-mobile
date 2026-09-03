// Immersion-time recording (MOBILE.md — viewing time). Two kinds of time,
// kept apart: active watching in the in-app player and passive listening in
// the native background service. The player feeds a ViewRecorder from its
// timeupdate ticks; the service keeps its own log (the webview is dead with
// the screen off) which importListenLog() drains into the same store.
//
// What counts: wall-clock seconds the media was actually advancing. A
// rewound stretch counts again (it was watched again); a seek, a pause, a
// buffering stall count nothing. Speed is folded out (10 media-minutes at
// 1.25× = 8 minutes of your time). `reached` vs `duration` records whether
// the episode was finished. Segments are per sitting, split at midnight so
// every second lands on the device-local day it was spent in.

import { PassiveAudio } from "./audio";
import {
  getOpenViewSegment,
  newId,
  recordViewSegment,
  setOpenViewSegment,
} from "./store";
import type { ViewKind, ViewSegment, ViewSource } from "./types";

// --- calendar ---------------------------------------------------------------

/** Device-local calendar day, YYYY-MM-DD. */
export function dayKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A day key as local midnight. */
export function dayDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(day: string, n: number): string {
  const d = dayDate(day);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

/** The Sunday on or before `day` — weeks run Sunday → Saturday. */
export function weekStart(day: string): string {
  return addDays(day, -dayDate(day).getDay());
}

// --- recorder ---------------------------------------------------------------

/** A media jump bigger than this between ticks is a seek, not playback. */
const MAX_TICK_SECS = 2;
/** Checkpoint the open segment this often (accrued seconds) — the cost of a
    process kill mid-playback. */
const CHECKPOINT_SECS = 5;

export interface RecorderOpts {
  episodeId: string;
  title: string;
  kind: ViewKind;
  now?: () => Date; // injectable clock (tests: midnight rollover)
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Accrues one playback surface's time into segments. Feed every position
    tick; call reanchor() when a seek starts; close() when leaving. Lazy: the
    segment opens on the first counted tick, so a player that's opened and
    never played records nothing. */
export class ViewRecorder {
  private seg: ViewSegment | null = null;
  private lastPos: number | null = null;
  private sinceCheckpoint = 0;

  constructor(private readonly opts: RecorderOpts) {}

  /** Playback is at `pos` (media seconds), running at `rate`. */
  tick(pos: number, rate = 1, duration?: number): void {
    const now = this.opts.now?.() ?? new Date();
    const today = dayKey(now);
    if (this.seg && this.seg.day !== today) this.close(); // midnight: new day's segment
    const prev = this.lastPos;
    this.lastPos = pos;
    if (prev == null) return; // (re)anchoring — nothing to measure against yet
    const delta = pos - prev;
    if (delta <= 0 || delta > MAX_TICK_SECS) return; // rewind / seek: nothing played between ticks
    if (!this.seg) {
      this.seg = {
        id: newId(),
        episode_id: this.opts.episodeId,
        title: this.opts.title,
        kind: this.opts.kind,
        day: today,
        start: now.toISOString(),
        secs: 0,
        reached: pos,
        duration: null,
      };
    }
    this.seg.secs += delta / (rate > 0 ? rate : 1);
    if (pos > this.seg.reached) this.seg.reached = pos;
    if (duration != null && Number.isFinite(duration) && duration > 0) this.seg.duration = duration;
    this.sinceCheckpoint += delta;
    if (this.sinceCheckpoint >= CHECKPOINT_SECS) this.checkpoint();
  }

  /** A seek is underway: the next tick re-anchors instead of counting the jump. */
  reanchor(): void {
    this.lastPos = null;
  }

  /** Persist the open segment now (app going to background). */
  checkpoint(): void {
    this.sinceCheckpoint = 0;
    if (this.seg) setOpenViewSegment(this.seg);
  }

  /** End the sitting. Anything under a second of playback is noise. */
  close(): void {
    const seg = this.seg;
    this.seg = null;
    this.lastPos = null;
    this.sinceCheckpoint = 0;
    setOpenViewSegment(null);
    if (seg && seg.secs >= 1)
      recordViewSegment({ ...seg, secs: round1(seg.secs), reached: round1(seg.reached) });
  }

  /** The in-progress segment (tests / diagnostics). */
  get current(): ViewSegment | null {
    return this.seg;
  }
}

/** App start: a checkpointed segment still in the open slot means the
    process died mid-playback — keep what it had accrued. */
export function recoverOpenSegment(): boolean {
  const seg = getOpenViewSegment();
  if (!seg) return false;
  setOpenViewSegment(null);
  return seg.secs >= 1 && recordViewSegment(seg);
}

/** Pull the native service's closed listening segments into the local log
    (+ outbox), then ack them so the service drops its copies. `open` is the
    sitting still running in the service (display only — it lands in the
    log when the track closes). Best-effort: on the web build / with the
    plugin missing it's a no-op. */
export async function importListenLog(): Promise<{ added: number; open: ViewSegment | null }> {
  let entries: ViewSegment[];
  let open: ViewSegment | undefined;
  try {
    ({ entries, open } = await PassiveAudio.getListenLog());
  } catch {
    return { added: 0, open: null };
  }
  let added = 0;
  if (entries?.length) {
    for (const e of entries) if (recordViewSegment(e)) added++;
    try {
      await PassiveAudio.clearListenLog({ ids: entries.map((e) => e.id) });
    } catch {
      /* re-imported next time; recordViewSegment dedupes on id */
    }
  }
  return { added, open: open ?? null };
}

// --- aggregation for the Progress tab ----------------------------------------

export interface EpisodeTime {
  episode_id: string;
  title: string;
  kind: ViewKind;
  secs: number;
  reached: number;
  duration: number | null;
  source: ViewSource;
  ids: string[]; // the sittings folded into this row (a manual row is one)
}

/** How a day's sittings fold into rows: app sittings by episode + kind;
    imported sheet rows by title + kind (one spreadsheet line = one show);
    hand-typed entries never merge, so each keeps its own ✕. */
function rowKey(s: ViewSegment): string {
  if (s.source === "manual") return `m:${s.id}`;
  if (s.source === "import") return `i:${s.kind}:${s.title}`;
  return `${s.episode_id}|${s.kind}`;
}

export interface DayTime {
  day: string;
  watch: number;
  listen: number;
  episodes: EpisodeTime[]; // longest first
}

export interface WeekTime {
  start: string; // Sunday
  end: string; // Saturday
  watch: number;
  listen: number;
  days: DayTime[]; // newest first
}

/** Fold segments into weeks (Sun→Sat) → days → per-episode rows, newest
    first at every level. Only days/weeks with time appear. */
export function groupWeeks(segs: ViewSegment[]): WeekTime[] {
  const days = new Map<string, DayTime>();
  const rows = new Map<string, EpisodeTime>(); // `${day}#${rowKey}` → row
  for (const s of segs) {
    let d = days.get(s.day);
    if (!d) days.set(s.day, (d = { day: s.day, watch: 0, listen: 0, episodes: [] }));
    d[s.kind] += s.secs;
    const key = `${s.day}#${rowKey(s)}`;
    let e = rows.get(key);
    if (!e) {
      e = {
        episode_id: s.episode_id, title: s.title, kind: s.kind,
        secs: 0, reached: 0, duration: null, source: s.source ?? "app", ids: [],
      };
      rows.set(key, e);
      d.episodes.push(e);
    }
    e.ids.push(s.id);
    e.secs += s.secs;
    if (s.reached > e.reached) e.reached = s.reached;
    if (s.duration != null && (e.duration == null || s.duration > e.duration)) e.duration = s.duration;
    if (!e.title && s.title) e.title = s.title;
  }
  const weeks = new Map<string, WeekTime>();
  for (const d of days.values()) {
    d.episodes.sort((a, b) => b.secs - a.secs);
    const start = weekStart(d.day);
    let w = weeks.get(start);
    if (!w) weeks.set(start, (w = { start, end: addDays(start, 6), watch: 0, listen: 0, days: [] }));
    w.watch += d.watch;
    w.listen += d.listen;
    w.days.push(d);
  }
  const out = [...weeks.values()];
  for (const w of out) w.days.sort((a, b) => (a.day < b.day ? 1 : -1));
  out.sort((a, b) => (a.start < b.start ? 1 : -1));
  return out;
}

/** Where the week stands against the goal. `openDays` counts today through
    Saturday (today is still open); `perDaySecs` is the even pace over them
    to land on the goal, 0 once it's met. */
export interface GoalStatus {
  goalSecs: number;
  doneSecs: number;
  leftSecs: number;
  openDays: number;
  perDaySecs: number;
  met: boolean;
}

export function goalStatus(doneSecs: number, goalHours: number, today: string): GoalStatus {
  const goalSecs = goalHours * 3600;
  const leftSecs = Math.max(0, goalSecs - doneSecs);
  const openDays = 7 - dayDate(today).getDay(); // Sun=0 → 7 … Sat=6 → 1
  return {
    goalSecs,
    doneSecs,
    leftSecs,
    openDays,
    perDaySecs: leftSecs > 0 ? leftSecs / openDays : 0,
    met: leftSecs <= 0,
  };
}

/** A hand-typed sitting (listening or watching done outside the app). */
export function manualSegment(
  day: string,
  minutes: number,
  kind: ViewKind,
  what = "",
): ViewSegment {
  return {
    id: newId(),
    episode_id: "manual",
    title: what.trim() || (kind === "listen" ? "listening outside the app" : "watching outside the app"),
    kind,
    day,
    start: new Date().toISOString(),
    secs: Math.round(minutes * 60),
    reached: 0,
    duration: null,
    source: "manual",
  };
}

/** Did the sitting(s) get to the end? Within the last 10 s counts (the same
    bar the player's resume position uses). null = length unknown. */
export function completion(e: { reached: number; duration: number | null }): number | null {
  if (e.duration == null || e.duration <= 0) return null;
  if (e.reached >= e.duration - 10) return 1;
  return Math.min(1, Math.max(0, e.reached / e.duration));
}

/** "0m" · "<1m" · "12m" · "1h 05m". */
export function fmtDur(secs: number): string {
  const m = Math.round(secs / 60);
  if (m === 0) return secs > 0 ? "<1m" : "0m";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h ? `${h}h ${String(mm).padStart(2, "0")}m` : `${mm}m`;
}
