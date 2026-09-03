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
import type { Stats, ViewSegment } from "../types";

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

function renderStats(bannerBox: HTMLElement, root: HTMLElement, s: Stats): void {
  // confirm banner: items (words + phrases + grammar) awaiting a "do you
  // know this?" — the count is the all-kinds total from the server. It
  // paints into its own slot above the time log so it stays first.
  if (s.confirm_candidates > 0) {
    const n = s.confirm_candidates;
    const banner = el("a", "confirm-banner") as HTMLAnchorElement;
    banner.href = "#/confirm";
    banner.appendChild(el("span", "cb-text",
      `🧠 ${n} item${n > 1 ? "s" : ""} to confirm you know`));
    banner.appendChild(el("span", "cb-go", "Review →"));
    bannerBox.appendChild(banner);
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

  // evidence provenance — where the known-set came from
  const src = s.evidence_by_source;
  // Note: there's no "marked unknown" — the tap cycle is known → want-to-learn
  // → clear; anything not marked known is unknown by default. Legacy
  // tap_unknown evidence (from the removed option) is intentionally not shown.
  const SRC_LABELS: Record<string, string> = {
    exposure: "Exposures (words met while watching)",
    tap_known: "Marked known",
    tap_interest: "Marked to learn",
    import: "Imported from an external list",
    mined_card: "Mined cards",
    card_lapse: "Card lapses",
  };
  const keys = Object.keys(SRC_LABELS).filter((k) => src[k]);
  if (keys.length) {
    root.appendChild(el("h2", "", "Evidence on record"));
    const kv2 = el("div", "kv");
    for (const k of keys) {
      kv2.appendChild(el("span", "k", SRC_LABELS[k]));
      kv2.appendChild(el("span", "v", nf.format(src[k])));
    }
    root.appendChild(kv2);
  }
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
