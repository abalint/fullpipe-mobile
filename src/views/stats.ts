// Progress tab: the payoff of the known-lemma ledger, finally visible. Headline
// counts + frequency-band coverage (of the N most common corpus words, how many
// you know) from GET /stats. Ledger-sourced server-side, so it reads with Anki
// closed; the last snapshot is cached for an offline glance.

import { api, ApiError } from "../api";
import { cacheStats, getCachedStats } from "../store";
import type { Stats } from "../types";

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

function renderStats(root: HTMLElement, s: Stats): void {
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
  const body = el("div");
  root.appendChild(body);

  const paint = (s: Stats) => {
    body.textContent = "";
    renderStats(body, s);
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
