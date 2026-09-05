// Pages: URL detection, the page bundle download, and the reader view —
// posts render as tap targets, taps open the shared gloss popup, marks cycle
// the shared tap store, submit/finished land in the outbox.
// Run: npx vitest run

import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const server = new Map<string, string>(); // url → body (missing entries 404)

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    downloadFile: vi.fn(async ({ url, path }: { url: string; path: string }) => {
      const body = server.get(url.split("?")[0]);
      if (body === undefined) throw new Error("404");
      files.set(path, body);
    }),
    readFile: vi.fn(async ({ path }: { path: string }) => {
      if (!files.has(path)) throw new Error("ENOENT");
      return { data: files.get(path)! };
    }),
    rename: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
    deleteFile: vi.fn(async ({ path }: { path: string }) => void files.delete(path)),
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ size: 1 })),
    addListener: vi.fn(async () => ({ remove: () => {} })),
  },
}));

import { downloadPage, deletePageFiles, getPageRecord, isPageSource } from "./pages";
import { readerView } from "./views/reader";
import { getOutbox, getTaps, saveSettings } from "./store";
import { TAP_SYNC_DELAY_MS } from "./livesync";
import type { PageDoc, TranscriptDoc } from "./types";

const EP = "page_5ch_newsplus_1787045314";
const BASE = "http://pc:8000";

const PAGE: PageDoc = {
  episode_id: EP,
  title: "【テスト】犬が公園で走る",
  url: "https://asahi.5ch.net/test/read.cgi/newsplus/1787045314/",
  site: "5ch",
  board: "newsplus",
  post_count: 2,
  posts: [
    { n: 1, name: "記者 ★", date: "2026/08/18", uid: "abc123", replies_to: [], lines: [[0], [], [1]] },
    { n: 2, name: "名無し", date: "2026/08/18", uid: "def456", replies_to: [1], lines: [[2]] },
  ],
};

const TRANSCRIPT: TranscriptDoc = {
  episode_id: EP,
  curated: false,
  confirm: ["走る"], // the ledger thinks 走る is known — awaiting a yes/no
  sentences: [
    {
      idx: 0,
      start: 0,
      end: 0,
      tokens: [
        { s: "犬", l: "犬", r: "いぬ", c: true, k: false },
        { s: "が", l: "が", c: false, k: true },
        { s: "走る", l: "走る", r: "はしる", c: true, k: true },
      ],
    },
    { idx: 1, start: 0, end: 0, tokens: [{ s: "公園", l: "公園", r: "こうえん", c: true, k: false }] },
    { idx: 2, start: 0, end: 0, tokens: [{ s: "猫", l: "猫", r: "ねこ", c: true, k: false }] },
  ],
};

const DEFS = { 犬: [{ k: ["犬"], r: ["いぬ"], s: [{ pos: ["noun"], g: ["dog"] }] }] };

function stageServer(): void {
  server.set(`${BASE}/page/${EP}`, JSON.stringify(PAGE));
  server.set(`${BASE}/transcript/${EP}`, JSON.stringify(TRANSCRIPT));
  server.set(`${BASE}/definitions/${EP}`, JSON.stringify(DEFS));
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function mountReader(): Promise<HTMLElement> {
  const view = readerView(EP);
  document.body.appendChild(view);
  await vi.waitFor(() => {
    if (!view.querySelector(".post")) throw new Error("not rendered yet");
  });
  return view;
}

beforeEach(() => {
  localStorage.clear();
  files.clear();
  server.clear();
  document.body.innerHTML = "";
  saveSettings({ serverUrl: BASE, token: "" });
  vi.stubGlobal("confirm", () => true);
  // flushOutbox probes the network after submit — fail fast, actions stay queued
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
});

describe("isPageSource", () => {
  it("matches itest and classic 5ch thread URLs only", () => {
    expect(isPageSource("https://itest.5ch.io/asahi/test/read.cgi/newsplus/1787045314")).toBe(true);
    expect(isPageSource("https://asahi.5ch.net/test/read.cgi/newsplus/1787045314/")).toBe(true);
    expect(isPageSource("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(isPageSource("https://itest.5ch.io/subback/newsplus")).toBe(false);
  });
});

describe("page bundle", () => {
  it("downloads all three artifacts and records the bundle", async () => {
    stageServer();
    const rec = await downloadPage(EP);
    expect(rec.postCount).toBe(2);
    expect(rec.title).toContain("犬");
    expect(rec.curated).toBe(false);
    expect(files.has(`pages/${EP}.page.json`)).toBe(true);
    expect(files.has(`pages/${EP}.definitions.json`)).toBe(true);
  });

  it("survives missing definitions (jmdict not built yet)", async () => {
    stageServer();
    server.delete(`${BASE}/definitions/${EP}`);
    const rec = await downloadPage(EP);
    expect(rec.defsPath).toBeUndefined();
  });

  it("deletePageFiles clears files and record", async () => {
    stageServer();
    await downloadPage(EP);
    await deletePageFiles(EP);
    expect(getPageRecord(EP)).toBeNull();
    expect(files.has(`pages/${EP}.page.json`)).toBe(false);
  });
});

describe("readerView", () => {
  beforeEach(async () => {
    stageServer();
    await downloadPage(EP); // pre-downloaded — reader reads from disk
  });

  it("renders posts with headers, blank lines, and tappable words", async () => {
    const view = await mountReader();
    const posts = view.querySelectorAll(".post");
    expect(posts.length).toBe(2);
    expect(posts[0].querySelector(".post-n")?.textContent).toBe("1");
    expect(posts[0].querySelectorAll(".post-line").length).toBe(3);
    expect(posts[0].querySelector(".post-line.blank")).toBeTruthy();
    // every token is a tap target in the reader (anyWord), known or not
    const spans = [...posts[0].querySelectorAll<HTMLElement>(".w[data-lemma]")];
    expect(spans.map((w) => w.dataset.lemma)).toEqual(["犬", "が", "走る", "公園"]);
    // reply chip on post 2
    expect(posts[1].querySelector(".post-reply")?.textContent).toBe("≫1");
  });

  it("tap → popup with JMdict sense; mark button cycles the shared store", async () => {
    const view = await mountReader();
    (view.querySelector('.w[data-lemma="犬"]') as HTMLElement).click();
    const pop = view.querySelector(".gloss-pop") as HTMLElement;
    expect(pop.style.display).not.toBe("none");
    expect(pop.classList.contains("fixed")).toBe(true);
    expect(pop.textContent).toContain("dog");
    (pop.querySelector(".gp-mark") as HTMLElement).click();
    expect(getTaps(EP)["犬"]).toBe("k");
    // the tapped word repaints as marked in the article
    expect(view.querySelector('.w[data-lemma="犬"]')?.classList.contains("tap-k")).toBe(true);
  });

  it("paints the think-you-know queue blue, leaving other words alone", async () => {
    const view = await mountReader();
    const cls = (lemma: string) =>
      view.querySelector(`.w[data-lemma="${lemma}"]`)!.classList.contains("hl-know");
    expect(cls("走る")).toBe(true);
    expect(cls("犬")).toBe(false);
  });

  it("furigana and highlight toggles flip root classes and persist", async () => {
    let view = await mountReader();
    const btn = (v: HTMLElement, label: string) =>
      [...v.querySelectorAll<HTMLButtonElement>(".reader-toolbar button")].find(
        (b) => b.textContent === label,
      )!;
    expect(view.classList.contains("no-ruby")).toBe(false);
    expect(view.classList.contains("no-hl")).toBe(false);
    btn(view, "あ").click();
    btn(view, "◨ hl").click();
    expect(view.classList.contains("no-ruby")).toBe(true);
    expect(view.classList.contains("no-hl")).toBe(true);
    // persisted: a fresh mount comes up with both still off
    document.body.innerHTML = "";
    view = await mountReader();
    expect(view.classList.contains("no-ruby")).toBe(true);
    expect(view.classList.contains("no-hl")).toBe(true);
    btn(view, "あ").click();
    expect(view.classList.contains("no-ruby")).toBe(false);
  });

  it("a mark syncs on its own (debounced) — no submit button; finished queues watched without cards", async () => {
    const view = await mountReader();
    expect(
      [...view.querySelectorAll<HTMLButtonElement>(".reader-toolbar button")].some((b) =>
        b.textContent?.startsWith("⇪"),
      ),
    ).toBe(false);
    vi.useFakeTimers();
    (view.querySelector('.w[data-lemma="犬"]') as HTMLElement).click();
    (view.querySelector(".gp-mark") as HTMLElement).click();
    const state = view.querySelector(".reader-toolbar .sync-state")!;
    expect(state.textContent).toBe("⇪ 1…"); // debouncing
    expect(getOutbox().length).toBe(0); // not frozen yet
    await vi.advanceTimersByTimeAsync(TAP_SYNC_DELAY_MS + 10);
    vi.useRealTimers();
    await tick();
    let outbox = getOutbox();
    expect(outbox.some((a) => a.kind === "taps" && a.batch.taps.length === 1)).toBe(true);
    // the flush failed (offline stub) → the batch waits; the marks read as queued
    expect(state.textContent).toBe("⇪ queued");

    const done = [...view.querySelectorAll<HTMLButtonElement>(".reader-toolbar button")].find(
      (b) => b.textContent?.startsWith("✓"),
    )!;
    done.click();
    await tick();
    outbox = getOutbox();
    const watched = outbox.find((a) => a.kind === "watched");
    expect(watched && watched.kind === "watched" && watched.cards).toBe(false);
    expect(done.disabled).toBe(true); // now pending — reads as "read (syncing)"
  });
});
