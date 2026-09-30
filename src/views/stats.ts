// Progress tab: the payoff of the known-lemma ledger, finally visible. Headline
// counts + frequency-band coverage (of the N most common corpus words, how many
// you know) from GET /stats. Ledger-sourced server-side, so it reads with Anki
// closed; the last snapshot is cached for an offline glance.

import { api, ApiError } from "../api";
import {
  cacheStats,
  deleteViewSegment,
  getCachedStats,
  getViewLog,
  mergeViewSegments,
  recordViewSegment,
  requeueViewSegments,
} from "../store";
import { flushOutbox } from "../sync";
import { importListenLog } from "../viewtime";
import { renderViewtime } from "./viewtime";
import type { MediumStats, ReadingPoint, Stats, ViewSegment } from "../types";

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const nf = new Intl.NumberFormat();

function tile(num: string, lab: string, sub?: string, tone?: "accent" | "know"): HTMLElement {
  const t = el("div", "stat-tile");
  t.appendChild(el("div", `num${tone ? " " + tone : ""}`, num));
  t.appendChild(el("div", "lab", lab));
  if (sub) t.appendChild(el("div", "sub", sub));
  return t;
}

function pct(known: number, total: number): number {
  return total > 0 ? Math.round((known / total) * 100) : 0;
}

/** One "N things → Review" link into a word-list view. */
function listBanner(href: string, cls: string, text: string): HTMLAnchorElement {
  const banner = el("a", `confirm-banner ${cls}`) as HTMLAnchorElement;
  banner.href = href;
  banner.appendChild(el("span", "cb-text", text));
  banner.appendChild(el("span", "cb-go", "Review →"));
  return banner;
}

function renderStats(bannerBox: HTMLElement, root: HTMLElement, s: Stats): void {
  // the three global word lists (LIVE_REVIEW.md §1), each a link to its
  // review view. Confirm first — items (words + phrases + grammar) awaiting
  // a "do you know this?", the all-kinds total from the server — then the ★
  // want-to-learn set and the should-know window. They paint into their own
  // slot above the time log so they stay first.
  if (s.confirm_candidates > 0) {
    const n = s.confirm_candidates;
    bannerBox.appendChild(listBanner("#/confirm", "cb-confirm",
      `🧠 ${n} item${n > 1 ? "s" : ""} to confirm you know`));
  }
  if (s.want_to_learn > 0) {
    const n = s.want_to_learn;
    bannerBox.appendChild(listBanner("#/list/interest", "cb-interest",
      `★ ${n} word${n > 1 ? "s" : ""} you want to learn`));
  }
  if (s.should_know) {
    const n = s.should_know;
    bannerBox.appendChild(listBanner("#/list/should_know", "cb-should",
      `${n} most common word${n > 1 ? "s" : ""} you should know`));
  }

  // headline tiles
  const grid = el("div", "stat-grid");
  const top1k = s.freq_bands.find((b) => b.band === 1000);
  grid.append(
    tile(nf.format(s.known), "words known", `+${nf.format(s.learning)} learning`, "know"),
    top1k
      ? tile(`${pct(top1k.known, top1k.total)}%`, "of the 1,000 most common words",
             `${nf.format(top1k.known)} / ${nf.format(top1k.total)}`, "accent")
      : tile("—", "of the most common words"),
    tile(nf.format(s.episodes_watched), "episodes watched",
         `${nf.format(s.episodes_total)} analyzed`),
    tile(nf.format(s.cards_minted), "cards minted",
         s.needs_review ? `${s.needs_review} need review` : undefined),
  );
  root.appendChild(grid);

  // frequency-band coverage bars — the growth curve you're climbing
  root.appendChild(el("h2", "", "Coverage by frequency"));
  root.appendChild(el(
    "div", "muted",
    "Of the most common words in native media, how many you know. The higher " +
    "bands fill last — that's the long tail.",
  ));
  for (const b of s.freq_bands) {
    const row = el("div", "freqrow");
    const head = el("div", "freqhead");
    head.appendChild(el("span", "cap", `top ${nf.format(b.total)}`));
    head.appendChild(el("span", "val", `${nf.format(b.known)} · ${pct(b.known, b.total)}%`));
    row.appendChild(head);
    const track = el("div", "freqtrack");
    const fill = el("div", "freqfill");
    fill.style.width = `${pct(b.known, b.total)}%`;
    track.appendChild(fill);
    row.appendChild(track);
    root.appendChild(row);
  }

  // secondary counts
  root.appendChild(el("h2", "", "Immersion so far"));
  const kv = el("div", "kv");
  const line = (k: string, v: number) => {
    kv.appendChild(el("span", "k", k));
    kv.appendChild(el("span", "v", nf.format(v)));
  };
  line("Distinct words encountered", s.words_encountered);
  line("Words you want to learn", s.want_to_learn);
  root.appendChild(kv);

  // watching / reading / listening side by side (2026-09-22): what each
  // medium has shown you, what you looked up and marked there, and what it
  // tipped into known. Hidden on a pre-media server.
  if (s.media) renderMedia(root, s);

  // phrases + grammar — the two sibling tracked axes (GRAMMAR.md). Hidden
  // entirely on pre-grammar servers / before anything is tracked.
  const phrasesTracked = (s.phrases_known ?? 0) + (s.phrases_learning ?? 0);
  const grammarTracked = (s.grammar_known ?? 0) + (s.grammar_learning ?? 0);
  if (phrasesTracked || grammarTracked) {
    root.appendChild(el("h2", "", "Phrases & grammar"));
    const grid2 = el("div", "stat-grid");
    if (phrasesTracked)
      grid2.appendChild(tile(nf.format(s.phrases_known ?? 0), "phrases known",
        `+${nf.format(s.phrases_learning ?? 0)} learning`, "know"));
    if (grammarTracked)
      grid2.appendChild(tile(nf.format(s.grammar_known ?? 0), "grammar points known",
        `+${nf.format(s.grammar_learning ?? 0)} learning`, "know"));
    root.appendChild(grid2);
  }
}

const MEDIA: { key: "watch" | "read" | "listen"; label: string }[] = [
  { key: "watch", label: "▶ watching" },
  { key: "read", label: "📖 reading" },
  { key: "listen", label: "🎧 listening" },
];

/** The per-medium table: one column per medium, one row per measure. Rows
    that are zero across every medium are skipped (a listener with no reads
    yet still sees a reading column — the split is the point). */
function renderMedia(root: HTMLElement, s: Stats): void {
  const m = s.media!;
  root.appendChild(el("h2", "", "By medium"));
  root.appendChild(el(
    "div", "muted",
    "Words only. What each medium has shown you. Words seen count every sighting your sittings " +
    "played; unique words are the distinct ones. \"First met\" credits the medium a word " +
    "turned up in first; \"became known\" counts the words a mark or confirm made there " +
    "tipped into known.",
  ));
  const h1 = (n: number) => (n >= 10 ? nf.format(Math.round(n)) : n.toFixed(1));
  const num = (v?: number | null) => (v ? nf.format(Math.round(v)) : "");
  const rows: { label: string; get: (x: MediumStats) => string; nonzero: (x: MediumStats) => boolean }[] = [
    { label: "Hours", get: (x) => h1(x.hours), nonzero: (x) => x.hours > 0 },
    { label: "Sittings", get: (x) => nf.format(x.sittings), nonzero: (x) => x.sittings > 0 },
    { label: "Episodes / volumes", get: (x) => nf.format(x.episodes), nonzero: (x) => x.episodes > 0 },
    { label: "Pages read", get: (x) => num(x.pages_read), nonzero: (x) => !!x.pages_read },
    { label: "…page turns", get: (x) => num(x.pages_turned), nonzero: (x) => !!x.pages_turned },
    { label: "Words seen", get: (x) => nf.format(x.words_seen), nonzero: (x) => x.words_seen > 0 },
    { label: "…per hour", get: (x) => num(x.words_per_hour), nonzero: (x) => !!x.words_per_hour },
    { label: "Characters read", get: (x) => num(x.chars_read), nonzero: (x) => !!x.chars_read },
    { label: "…per minute", get: (x) => num(x.chars_per_minute), nonzero: (x) => !!x.chars_per_minute },
    { label: "Unique words", get: (x) => nf.format(x.unique_words), nonzero: (x) => x.unique_words > 0 },
    { label: "…only here", get: (x) => nf.format(x.only_here), nonzero: (x) => x.only_here > 0 },
    { label: "…known now", get: (x) => nf.format(x.unique_known), nonzero: (x) => x.unique_known > 0 },
    { label: "First met here", get: (x) => nf.format(x.first_met), nonzero: (x) => x.first_met > 0 },
    { label: "…known now", get: (x) => nf.format(x.first_met_known), nonzero: (x) => x.first_met_known > 0 },
    { label: "Lookups", get: (x) => nf.format(x.lookups), nonzero: (x) => x.lookups > 0 },
    { label: "…distinct words", get: (x) => nf.format(x.unique_looked_up), nonzero: (x) => x.unique_looked_up > 0 },
    { label: "Marked known ✓", get: (x) => nf.format(x.marked_known), nonzero: (x) => x.marked_known > 0 },
    { label: "Marked to learn ★", get: (x) => nf.format(x.marked_interest), nonzero: (x) => x.marked_interest > 0 },
    { label: "Marked unknown ✗", get: (x) => nf.format(x.marked_unknown), nonzero: (x) => x.marked_unknown > 0 },
    { label: "Became known", get: (x) => nf.format(x.became_known), nonzero: (x) => x.became_known > 0 },
    { label: `…last ${m.since_days} days`, get: (x) => nf.format(x.became_known_30d), nonzero: (x) => x.became_known_30d > 0 },
    { label: "Back to learning", get: (x) => nf.format(x.became_learning), nonzero: (x) => x.became_learning > 0 },
  ];
  const wrap = el("div", "media-wrap");
  const table = document.createElement("table");
  table.className = "media-table";
  const thead = table.createTHead();
  const hr = thead.insertRow();
  hr.appendChild(document.createElement("th"));
  for (const c of MEDIA) {
    const th = document.createElement("th");
    th.textContent = c.label;
    hr.appendChild(th);
  }
  const tbody = table.createTBody();
  for (const r of rows) {
    if (!MEDIA.some((c) => r.nonzero(m.media[c.key]))) continue;
    const tr = tbody.insertRow();
    const th = document.createElement("th");
    th.textContent = r.label;
    if (r.label.startsWith("…")) th.className = "sub";
    tr.appendChild(th);
    for (const c of MEDIA) {
      const td = tr.insertCell();
      const x = m.media[c.key];
      td.textContent = r.nonzero(x) ? r.get(x) : "–";
    }
  }
  wrap.appendChild(table);
  root.appendChild(wrap);

  if (m.reading && m.reading.days.length) renderReadingSpeed(root, m.reading.days);

  // marks made outside any medium — a list review, the confirm queue
  const e = m.elsewhere;
  const kv = el("div", "kv");
  const line = (k: string, v: number) => {
    if (!v) return;
    kv.appendChild(el("span", "k", k));
    kv.appendChild(el("span", "v", nf.format(v)));
  };
  line("Marked known from a list review", e.list.marked_known);
  line("Marked unknown from a list review", e.list.marked_unknown);
  line("Confirmed known (\"do you know this?\")", e.confirm.confirmed ?? 0);
  line("Deferred (\"not yet\")", e.confirm.deferred ?? 0);
  line("Became known via an import", e.import.became_known);
  if (kv.childElementCount) root.appendChild(kv);
}

const SVG = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function shortDay(day: string): string {
  const [, mm, dd] = day.split("-");
  return `${Number(mm)}/${Number(dd)}`;
}

/** Reading speed over time: one line, characters per minute by day — the
    unit Japanese readers measure themselves in (字/分; adult prose reads
    around 500–600) — with a gap on days nothing was measured, a crosshair +
    tooltip on touch / hover, and the same points as a table underneath. */
function renderReadingSpeed(root: HTMLElement, days: ReadingPoint[]): void {
  root.appendChild(el("h2", "", "Reading speed"));
  root.appendChild(el(
    "div", "muted",
    "Characters per minute in the manga reader, by day: the kana and kanji on the pages " +
    "each sitting showed over its wall-clock minutes. Adult native readers of ordinary " +
    "prose sit around 500–600.",
  ));
  const pts = days.filter((d) => d.cpm !== null);
  const card = el("div", "speed-card");
  if (pts.length) {
    const W = 360, H = 170, L = 34, R = 12, T = 14, B = 26;
    const max = Math.max(...pts.map((d) => d.cpm!));
    const top = Math.max(50, Math.ceil(max / 50) * 50);
    const n = days.length;
    const xOf = (i: number) => (n > 1 ? L + ((W - L - R) * i) / (n - 1) : (L + W - R) / 2);
    const yOf = (v: number) => T + (H - T - B) * (1 - v / top);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "speed-svg", role: "img",
      "aria-label": "reading speed, characters per minute by day" });
    // recessive grid + y labels
    for (const v of [0, top / 2, top]) {
      svg.appendChild(svgEl("line", { x1: L, x2: W - R, y1: yOf(v), y2: yOf(v), class: "grid" }));
      const t = svgEl("text", { x: L - 6, y: yOf(v) + 4, class: "ylab", "text-anchor": "end" });
      t.textContent = String(Math.round(v));
      svg.appendChild(t);
    }
    // x labels: first and last day (+ the middle one when there's room)
    const xi = n > 4 ? [0, Math.floor((n - 1) / 2), n - 1] : n > 1 ? [0, n - 1] : [0];
    for (const i of xi) {
      const t = svgEl("text", { x: xOf(i), y: H - 8, class: "xlab",
        "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" });
      t.textContent = shortDay(days[i].day!);
      svg.appendChild(t);
    }
    // the line, broken at unmeasured days
    let d = "";
    let pen = false;
    days.forEach((p, i) => {
      if (p.cpm === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(p.cpm).toFixed(1)}`;
      pen = true;
    });
    svg.appendChild(svgEl("path", { d, class: "speed-line" }));
    const cross = svgEl("line", { x1: 0, x2: 0, y1: T, y2: H - B, class: "cross" });
    cross.style.display = "none";
    svg.appendChild(cross);
    const dots: SVGCircleElement[] = [];
    days.forEach((p, i) => {
      if (p.cpm === null) return;
      const c = svgEl("circle", { cx: xOf(i), cy: yOf(p.cpm), r: 4, class: "speed-dot" });
      svg.appendChild(c);
      dots[i] = c;
    });
    const tip = el("div", "speed-tip");
    tip.hidden = true;
    const show = (i: number) => {
      const p = days[i];
      if (p.cpm === null) return;
      cross.setAttribute("x1", String(xOf(i)));
      cross.setAttribute("x2", String(xOf(i)));
      cross.style.display = "";
      dots.forEach((c, j) => c.classList.toggle("hot", j === i));
      tip.textContent =
        `${p.day} · ${Math.round(p.cpm)} chars/min · ${p.pages ?? 0} pages · ${p.minutes} min`;
      tip.hidden = false;
    };
    const hide = () => {
      cross.style.display = "none";
      dots.forEach((c) => c.classList.remove("hot"));
      tip.hidden = true;
    };
    const nearest = (clientX: number) => {
      const box = svg.getBoundingClientRect();
      const x = ((clientX - box.left) / (box.width || 1)) * W;
      let best = -1;
      let bestD = Infinity;
      days.forEach((p, i) => {
        if (p.cpm === null) return;
        const dd = Math.abs(xOf(i) - x);
        if (dd < bestD) { bestD = dd; best = i; }
      });
      return best;
    };
    svg.addEventListener("pointermove", (e) => { const i = nearest(e.clientX); if (i >= 0) show(i); });
    svg.addEventListener("pointerdown", (e) => { const i = nearest(e.clientX); if (i >= 0) show(i); });
    svg.addEventListener("pointerleave", hide);
    card.appendChild(svg);
    card.appendChild(tip);
    // the latest day, direct-labelled
    const last = pts[pts.length - 1];
    card.appendChild(el("div", "speed-now",
      `latest: ${Math.round(last.cpm!)} chars/min on ${shortDay(last.day!)}`));
  } else {
    card.appendChild(el("div", "muted", "No measured reading yet — a volume's pages get " +
      "character counts when its coverage pass runs."));
  }
  root.appendChild(card);

  // table view of the same points
  const det = document.createElement("details");
  det.className = "speed-table";
  const sum = document.createElement("summary");
  sum.textContent = "By day";
  det.appendChild(sum);
  const wrap = el("div", "media-wrap");
  const table = document.createElement("table");
  table.className = "media-table";
  const hr = table.createTHead().insertRow();
  for (const h of ["day", "pages", "chars", "min", "ch/min"]) {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  }
  const body = table.createTBody();
  for (const p of [...days].reverse()) {
    const tr = body.insertRow();
    const th = document.createElement("th");
    th.textContent = p.day!;
    tr.appendChild(th);
    for (const v of [p.pages ?? 0, p.chars, p.minutes, p.cpm === null ? null : Math.round(p.cpm)]) {
      const td = tr.insertCell();
      td.textContent = v === null ? "–" : typeof v === "number" && !Number.isInteger(v) ? v.toFixed(1) : nf.format(v);
    }
  }
  wrap.appendChild(table);
  det.appendChild(wrap);
  root.appendChild(det);
}

export function statsView(): HTMLElement {
  const root = el("div", "view");
  root.appendChild(el("h1", "", "Progress"));
  const status = el("div", "status", "loading…");
  root.appendChild(status);
  const bannerBox = el("div");
  root.appendChild(bannerBox);

  // immersion time (viewtime.ts): phone-local, so it paints at once and
  // works offline; the native listening log and the server's copy of the
  // history fold in as they arrive
  const timeBox = el("div", "viewtime");
  root.appendChild(timeBox);
  let listening: ViewSegment | null = null; // the service's sitting in progress
  const paintTime = () => {
    timeBox.textContent = "";
    renderViewtime(timeBox, listening ? [...getViewLog(), listening] : getViewLog(), undefined, {
      // hand-typed entries: into the log + outbox like a recorded sitting
      onAdd: (seg) => {
        recordViewSegment(seg);
        void flushOutbox();
        paintTime();
      },
      onDelete: (id) => {
        deleteViewSegment(id);
        void flushOutbox();
        paintTime();
      },
      onGoalChanged: paintTime,
    });
  };
  paintTime();
  void importListenLog().then(({ added, open }) => {
    listening = open;
    if ((added || open) && root.isConnected) paintTime();
  });
  void api
    .getViewtime()
    .then(({ sessions }) => {
      if (mergeViewSegments(sessions ?? []) && root.isConnected) paintTime();
      // and the other direction: anything the phone has that the server
      // doesn't goes back into the outbox (a dropped POST self-heals here)
      if (requeueViewSegments(new Set((sessions ?? []).map((s) => s.id)))) void flushOutbox();
    })
    .catch(() => {});

  const body = el("div", "ledger");
  root.appendChild(body);

  const paint = (s: Stats) => {
    bannerBox.textContent = "";
    body.textContent = "";
    renderStats(bannerBox, body, s);
  };

  // paint the cached snapshot instantly (if any), then refresh from the server
  const cached = getCachedStats();
  if (cached) {
    paint(cached.stats);
    status.textContent = `cached from ${new Date(cached.at).toLocaleString()} · refreshing…`;
  }

  void (async () => {
    try {
      const s = await api.getStats();
      cacheStats(s);
      status.textContent = "";
      paint(s);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      if (cached) {
        status.textContent = `⚠ offline — showing cached numbers from ${new Date(cached.at).toLocaleString()}`;
      } else {
        status.textContent = `⚠ offline — no cached progress yet (${msg})`;
      }
    }
  })();

  return root;
}
