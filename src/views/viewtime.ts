// Progress tab — immersion time: today / this-week / all-time tiles, then
// every week with time as a collapsible Sunday→Saturday block, days inside,
// one row per episode saying how long and whether it was finished. Active
// watching (▶) and passive listening (🎧) are counted apart throughout.

import {
  addDays,
  completion,
  dayDate,
  dayKey,
  fmtDur,
  groupWeeks,
  weekStart,
} from "../viewtime";
import { goalStatus, manualSegment } from "../viewtime";
import { getViewGoal, saveViewGoal } from "../store";
import type { ViewGoal } from "../store";
import type { DayTime, EpisodeTime, WeekTime } from "../viewtime";
import type { ViewKind, ViewSegment } from "../types";

/** What the Progress tab does with the section's edits. */
export interface ViewtimeActions {
  /** A hand-typed sitting was saved (already a full segment). */
  onAdd?: (seg: ViewSegment) => void;
  /** The ✕ on a hand-typed row. */
  onDelete?: (id: string) => void;
  /** The weekly goal was edited (already saved) — repaint. */
  onGoalChanged?: () => void;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const KIND_ICON = { watch: "▶", listen: "🎧" } as const;

/** "▶ 45m · 🎧 20m" — a zero side is dropped, both zero reads "0m". */
export function splitLabel(watch: number, listen: number): string {
  const parts: string[] = [];
  if (watch > 0) parts.push(`${KIND_ICON.watch} ${fmtDur(watch)}`);
  if (listen > 0) parts.push(`${KIND_ICON.listen} ${fmtDur(listen)}`);
  return parts.length ? parts.join(" · ") : "0m";
}

/** The small line under the today / this-week tiles: passive time only. */
export function passiveSub(listen: number): string {
  return `${KIND_ICON.listen} ${fmtDur(listen)} passive`;
}

const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", year: "numeric",
});
const WEEKDAY_DATE = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric",
});

/** "Aug 31 – Sep 6"; the year appears once the week isn't this year's. */
export function weekLabel(w: WeekTime, today: string): string {
  const thisYear = w.start.slice(0, 4) === today.slice(0, 4) && w.end.slice(0, 4) === today.slice(0, 4);
  const f = thisYear ? MONTH_DAY : MONTH_DAY_YEAR;
  return `${f.format(dayDate(w.start))} – ${f.format(dayDate(w.end))}`;
}

export function dayLabel(day: string, today: string): string {
  const base = WEEKDAY_DATE.format(dayDate(day));
  if (day === today) return `Today · ${base}`;
  if (day === addDays(today, -1)) return `Yesterday · ${base}`;
  return base;
}

function tile(num: string, lab: string, sub?: string, tone?: "accent" | "know"): HTMLElement {
  const t = el("div", "stat-tile");
  t.appendChild(el("div", `num${tone ? " " + tone : ""}`, num));
  t.appendChild(el("div", "lab", lab));
  if (sub) t.appendChild(el("div", "sub", sub));
  return t;
}

function episodeRow(e: EpisodeTime, actions: ViewtimeActions): HTMLElement {
  const row = el("div", `ep-row ${e.kind} src-${e.source}`);
  row.appendChild(el("span", "ep-kind", KIND_ICON[e.kind]));
  row.appendChild(el("span", "ep-title", e.title || e.episode_id));
  row.appendChild(el("span", "ep-time", fmtDur(e.secs)));
  const c = completion(e);
  if (c != null) {
    row.appendChild(
      c >= 1
        ? el("span", "ep-done finished", "finished")
        : el("span", "ep-done", `to ${Math.round(c * 100)}%`),
    );
  }
  if (e.source === "manual") {
    // typed in by hand → can be taken back; recorded sittings are facts and
    // imported rows are managed on the PC
    const mark = el("span", "ep-src", "✎");
    mark.title = "added by hand";
    row.appendChild(mark);
    const del = el("button", "ep-del", "✕") as HTMLButtonElement;
    del.title = "remove this entry";
    del.addEventListener("click", () => {
      if (confirm(`Remove "${e.title}" (${fmtDur(e.secs)})?`)) actions.onDelete?.(e.ids[0]);
    });
    row.appendChild(del);
  }
  return row;
}

function dayBlock(d: DayTime, today: string, actions: ViewtimeActions): HTMLElement {
  const block = el("div", "day");
  const head = el("div", "day-head");
  head.appendChild(el("span", "day-name", dayLabel(d.day, today)));
  head.appendChild(el("span", "day-tot", splitLabel(d.watch, d.listen)));
  block.appendChild(head);
  for (const e of d.episodes) block.appendChild(episodeRow(e, actions));
  return block;
}

/** A week's collapsible block. Day rows are built on first open — with a
    year and a half of imported history there are thousands of rows, and
    the closed weeks needn't cost anything. */
function weekBlock(w: WeekTime, today: string, open: boolean, actions: ViewtimeActions): HTMLElement {
  const det = el("details", "week") as HTMLDetailsElement;
  const sum = el("summary");
  sum.appendChild(el("span", "wk-range", weekLabel(w, today)));
  sum.appendChild(el("span", "wk-tot", splitLabel(w.watch, w.listen)));
  det.appendChild(sum);
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    for (const d of w.days) det.appendChild(dayBlock(d, today, actions));
  };
  det.addEventListener("toggle", () => {
    if (det.open) build();
  });
  if (open) {
    det.open = true;
    build();
  }
  return det;
}

/** The weekly goal card: hours aimed at, done/left this week, and the pace
    over the days still open (today included). Tap the goal to change it —
    the new number sticks until changed again. */
function goalCard(
  weekWatch: number,
  today: string,
  goal: ViewGoal,
  onChange: (g: ViewGoal) => void,
): HTMLElement {
  const card = el("div", "goal");
  const done = weekWatch; // active watching only — passive never counts
  const st = goalStatus(done, goal.hours, today);

  const head = el("div", "goal-head");
  const label = el("button", "goal-target") as HTMLButtonElement;
  label.type = "button";
  label.textContent = `weekly goal ${goal.hours % 1 ? goal.hours : goal.hours}h`;
  label.title = "change the goal";
  head.appendChild(label);
  head.appendChild(el("span", "goal-done",
    st.met ? `${fmtDur(done)} · goal met ✓` : `${fmtDur(done)} done · ${fmtDur(st.leftSecs)} left`));
  card.appendChild(head);

  const track = el("div", "freqtrack");
  const fill = el("div", `freqfill${st.met ? " met" : ""}`);
  fill.style.width = `${Math.min(100, Math.round((done / st.goalSecs) * 100))}%`;
  track.appendChild(fill);
  card.appendChild(track);

  const pace = el("div", "goal-pace");
  if (st.met) pace.textContent = `${st.openDays} day${st.openDays > 1 ? "s" : ""} still open — anything more is extra`;
  else
    pace.textContent =
      `${st.openDays} day${st.openDays > 1 ? "s" : ""} left counting today → ` +
      `${fmtDur(st.perDaySecs)} a day`;
  card.appendChild(pace);
  card.appendChild(el("div", "goal-note", "active watching only"));

  // editor: hours, shown on tap
  const form = el("form", "goal-form") as HTMLFormElement;
  form.hidden = true;
  const hrsLab = el("label", "", "hours / week ");
  const hrs = el("input") as HTMLInputElement;
  hrs.type = "number";
  hrs.min = "0.5";
  hrs.step = "0.5";
  hrs.inputMode = "decimal";
  hrs.value = String(goal.hours);
  hrsLab.appendChild(hrs);
  const row = el("div", "row");
  const save = el("button", "small primary", "save") as HTMLButtonElement;
  save.type = "submit";
  const cancel = el("button", "small", "cancel") as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", () => (form.hidden = true));
  row.append(save, cancel);
  form.append(hrsLab, row);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const h = Number(hrs.value);
    if (!Number.isFinite(h) || h <= 0) return;
    onChange({ hours: h });
  });
  label.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) hrs.focus();
  });
  card.appendChild(form);
  return card;
}

/** "＋ add time": day · minutes · listening/watching · what — for immersion
    done outside the app (the car radio, a podcast on another device). */
function addTimeForm(today: string, actions: ViewtimeActions): HTMLElement {
  const box = el("div", "addtime");
  const toggle = el("button", "small addtime-toggle", "＋ add time") as HTMLButtonElement;
  const form = el("form", "addtime-form") as HTMLFormElement;
  form.hidden = true;
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) minutes.focus();
  });

  const row1 = el("div", "row");
  const dayLab = el("label", "", "day ");
  const day = el("input") as HTMLInputElement;
  day.type = "date";
  day.value = today;
  day.max = today;
  dayLab.appendChild(day);
  const minLab = el("label", "", "minutes ");
  const minutes = el("input") as HTMLInputElement;
  minutes.type = "number";
  minutes.min = "1";
  minutes.step = "1";
  minutes.inputMode = "numeric";
  minutes.required = true;
  minLab.appendChild(minutes);
  row1.append(dayLab, minLab);

  let kind: ViewKind = "listen";
  const kindRow = el("div", "row kind");
  const kindBtns = (["listen", "watch"] as ViewKind[]).map((k) => {
    const b = el("button", `tag${k === kind ? " on" : ""}`,
      k === "listen" ? "🎧 listening" : "▶ watching") as HTMLButtonElement;
    b.type = "button";
    b.dataset.kind = k;
    b.addEventListener("click", () => {
      kind = k;
      kindBtns.forEach((x) => x.classList.toggle("on", x.dataset.kind === kind));
    });
    kindRow.appendChild(b);
    return b;
  });

  const what = el("input", "what") as HTMLInputElement;
  what.placeholder = "what was it? (optional)";

  const row3 = el("div", "row");
  const save = el("button", "small primary", "save") as HTMLButtonElement;
  save.type = "submit";
  const cancel = el("button", "small cancel", "cancel") as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", () => (form.hidden = true));
  row3.append(save, cancel);

  form.append(row1, kindRow, what, row3);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const m = Number(minutes.value);
    if (!Number.isFinite(m) || m <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day.value)) return;
    actions.onAdd?.(manualSegment(day.value, m, kind, what.value));
    minutes.value = "";
    what.value = "";
    form.hidden = true;
  });
  box.append(toggle, form);
  return box;
}

/** Weeks shown flat before the rest fold under "earlier". */
const FLAT_WEEKS = 12;

export function renderViewtime(
  root: HTMLElement,
  segs: ViewSegment[],
  today = dayKey(),
  actions: ViewtimeActions = {},
): void {
  root.appendChild(el("h2", "", "Immersion time"));
  const weeks = groupWeeks(segs);
  const thisWeek = weekStart(today);

  const todayT = weeks.flatMap((w) => w.days).find((d) => d.day === today);
  const weekT = weeks.find((w) => w.start === thisWeek);
  let allWatch = 0;
  let allListen = 0;
  for (const w of weeks) {
    allWatch += w.watch;
    allListen += w.listen;
  }
  const grid = el("div", "stat-grid time");
  // the big number is active watching only — that's the figure that matters;
  // passive listening sits small underneath and is never summed into it
  grid.append(
    tile(fmtDur(todayT?.watch ?? 0), "today", passiveSub(todayT?.listen ?? 0), "accent"),
    tile(fmtDur(weekT?.watch ?? 0), "this week", passiveSub(weekT?.listen ?? 0), "accent"),
    tile(fmtDur(allWatch), "watched, all time", "active — in the player", "know"),
    tile(fmtDur(allListen), "listened, all time", "passive — background audio", "know"),
  );
  root.appendChild(grid);
  root.appendChild(goalCard(weekT?.watch ?? 0, today, getViewGoal(), (g) => {
    saveViewGoal(g);
    actions.onGoalChanged?.();
  }));
  root.appendChild(addTimeForm(today, actions));

  if (!weeks.length) {
    root.appendChild(el(
      "div", "muted",
      "Nothing recorded yet — time starts counting when you play an episode " +
      "or listen in the background.",
    ));
    return;
  }

  const list = el("div", "weeks");
  const flat = weeks.slice(0, FLAT_WEEKS);
  const older = weeks.slice(FLAT_WEEKS);
  // the current week starts open; history stays folded until asked for
  for (const w of flat) list.appendChild(weekBlock(w, today, w.start === thisWeek, actions));
  if (older.length) {
    const more = el("details", "week-more") as HTMLDetailsElement;
    more.appendChild(el("summary", "", `${older.length} earlier week${older.length > 1 ? "s" : ""}`));
    for (const w of older) more.appendChild(weekBlock(w, today, false, actions));
    list.appendChild(more);
  }
  root.appendChild(list);
}
