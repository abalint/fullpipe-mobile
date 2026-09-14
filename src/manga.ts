// Manga bundles: the Read tab's download-then-read counterpart to video.ts
// for a volume from the PC library (tools.manga). A volume stages the
// reader structure (pages + bubbles), the tokenized sentence track, the
// per-volume dictionary and every page scan; all of it lands in
// app-internal storage (manga/<episode>/…) so a downloaded volume reads
// fully offline. Like series rows, delete here is phone-local — the PC
// keeps the pages, OCR and derived data for a reread.
//
// Also home to the reading-time recorder: pages read → a viewtime sitting
// whose `played` ranges are page spans in the transcript's pseudo-seconds
// (page index × page_secs), so the server credits word exposures for
// exactly the pages that were on screen — the manga form of "the line
// played" — and the Progress tab counts the time as immersion.

import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { api } from "./api";
import { getSettings, newId, recordViewSegment, setOpenViewSegment } from "./store";
import { readLocalJson, SIDECAR_FORMAT } from "./video";
import { dayKey, mergeRanges } from "./viewtime";
import type { Definitions, MangaDoc, TranscriptDoc, ViewSegment } from "./types";

export interface MangaRecord {
  docPath: string;
  transcriptPath: string;
  defsPath?: string;
  pagesDir: string;
  pageCount: number;
  /** Page scans on disk so far — a download can be resumed. */
  pagesDownloaded: number;
  curated?: boolean;
  format?: number;
  title?: string;
  at: string;
}

const key = (ep: string) => `fp.manga.${ep}`;
const pageKey = (ep: string) => `fp.mpage.${ep}`;
const dirKey = (slug: string) => `fp.manga.dir.${slug}`;

export function getMangaRecord(ep: string): MangaRecord | null {
  try {
    const raw = localStorage.getItem(key(ep));
    return raw ? (JSON.parse(raw) as MangaRecord) : null;
  } catch {
    return null;
  }
}

/** Every volume with a bundle on the phone (complete or partial). */
export function mangaRecords(): { ep: string; rec: MangaRecord }[] {
  const out: { ep: string; rec: MangaRecord }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith("fp.manga.") || k.startsWith("fp.manga.dir.")) continue;
    const ep = k.slice("fp.manga.".length);
    const rec = getMangaRecord(ep);
    if (rec) out.push({ ep, rec });
  }
  return out;
}

export function isComplete(rec: MangaRecord | null): boolean {
  return !!rec && rec.pagesDownloaded >= rec.pageCount;
}

// --- reading position / direction -------------------------------------------------

/** Last page index open in the reader (resume), or null. */
export function getMangaPage(ep: string): number | null {
  const raw = localStorage.getItem(pageKey(ep));
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function saveMangaPage(ep: string, page: number): void {
  localStorage.setItem(pageKey(ep), String(page));
}

export function clearMangaPage(ep: string): void {
  localStorage.removeItem(pageKey(ep));
}

export type ReadingDirection = "rtl" | "ltr";

/** Per-series page direction — manga is right-to-left unless the reader
    flips it (a left-to-right edition, a webtoon export). */
export function readingDirection(slug: string, fallback: ReadingDirection = "rtl"): ReadingDirection {
  const v = localStorage.getItem(dirKey(slug));
  return v === "ltr" || v === "rtl" ? v : fallback;
}

export function setReadingDirection(slug: string, dir: ReadingDirection): void {
  localStorage.setItem(dirKey(slug), dir);
}

// --- download / delete ------------------------------------------------------------------

async function download(url: string, path: string): Promise<void> {
  const { token } = getSettings();
  await Filesystem.downloadFile({
    url,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    path,
    directory: Directory.Data,
    recursive: true,
  });
}

async function ensureDir(path: string): Promise<void> {
  try {
    await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true });
  } catch {
    /* already exists */
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: Directory.Data });
    return true;
  } catch {
    return false;
  }
}

const PARALLEL = 3; // page pulls in flight at once (tailnet — modest)

/** Pull the volume bundle: structure + sentence track (required), dictionary
    (best-effort), then every page scan — resumable: pages already on disk
    are skipped, so an interrupted pull picks up where it stopped. Progress
    reports pages landed / total. */
export async function downloadManga(
  ep: string,
  onProgress?: (done: number, total: number) => void,
): Promise<MangaRecord> {
  const base = `manga/${ep}`;
  const docPath = `${base}/manga.json`;
  const transcriptPath = `${base}/transcript.json`;
  const defsPath = `${base}/definitions.json`;
  const pagesDir = `${base}/pages`;
  await ensureDir(pagesDir);
  await download(api.mangaUrl(ep), docPath);
  await download(api.transcriptUrl(ep), transcriptPath);
  let gotDefs = false;
  try {
    await download(api.definitionsUrl(ep), defsPath);
    gotDefs = true;
  } catch {
    /* definitions are best-effort */
  }
  const doc = await readLocalJson<MangaDoc>(docPath);
  const transcript = await readLocalJson<TranscriptDoc>(transcriptPath);
  if (!doc?.pages?.length) throw new Error("volume structure missing — is Stage 1 done?");

  const files = doc.pages.map((p) => p.file);
  let done = 0;
  const save = (): MangaRecord => {
    const rec: MangaRecord = {
      docPath,
      transcriptPath,
      defsPath: gotDefs ? defsPath : getMangaRecord(ep)?.defsPath,
      pagesDir,
      pageCount: files.length,
      pagesDownloaded: done,
      curated: transcript?.curated ?? false,
      format: SIDECAR_FORMAT,
      title: doc.title,
      at: new Date().toISOString(),
    };
    localStorage.setItem(key(ep), JSON.stringify(rec));
    return rec;
  };
  // resume: count what's already there before pulling the rest
  const missing: string[] = [];
  for (const f of files) {
    if (await exists(`${pagesDir}/${f}`)) done++;
    else missing.push(f);
  }
  onProgress?.(done, files.length);
  save();
  let next = 0;
  let failed: Error | null = null;
  const worker = async () => {
    while (next < missing.length && !failed) {
      const f = missing[next++];
      try {
        await download(api.mangaPageUrl(ep, f), `${pagesDir}/${f}`);
        done++;
        onProgress?.(done, files.length);
        if (done % 10 === 0) save();
      } catch (e) {
        failed = e as Error;
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const rec = save();
  if (failed) throw new Error(`page download failed after ${done}/${files.length}: ${(failed as Error).message}`);
  return rec;
}

/** Re-pull the volume structure + transcript + definitions while the PC
    is still working on the volume — the AI read rebuilds the sentence
    track and every bubble's line counts (manga.json), and the /immerse
    manga pass adds authored defs. No-op once curated on the current
    sidecar format; returns the fresh transcript, else null. Staged-then-
    swap so a failed pull never leaves a half-updated bundle. */
export async function refreshMangaSidecars(ep: string): Promise<TranscriptDoc | null> {
  const rec = getMangaRecord(ep);
  if (!rec || (rec.curated && (rec.format ?? 1) >= SIDECAR_FORMAT)) return null;
  const tPath = rec.transcriptPath;
  const mPath = rec.docPath;
  try {
    await download(api.transcriptUrl(ep), `${tPath}.fresh`);
    await download(api.mangaUrl(ep), `${mPath}.fresh`);
  } catch {
    return null;
  }
  const doc = await readLocalJson<TranscriptDoc>(`${tPath}.fresh`);
  const structure = await readLocalJson<MangaDoc>(`${mPath}.fresh`);
  if (!doc?.sentences?.length || !structure?.pages?.length) return null;
  for (const [from, to] of [[`${tPath}.fresh`, tPath], [`${mPath}.fresh`, mPath]])
    await Filesystem.rename({ from, to, directory: Directory.Data, toDirectory: Directory.Data });
  const defsPath = `manga/${ep}/definitions.json`;
  let gotDefs = !!rec.defsPath;
  try {
    await download(api.definitionsUrl(ep), defsPath);
    gotDefs = true;
  } catch {
    /* best-effort */
  }
  localStorage.setItem(
    key(ep),
    JSON.stringify({
      ...rec,
      defsPath: gotDefs ? defsPath : undefined,
      curated: doc.curated ?? false,
      format: SIDECAR_FORMAT,
    }),
  );
  return doc;
}

/** Phone-local removal of the bundle (pages included). Server untouched. */
export async function deleteMangaFiles(ep: string): Promise<void> {
  try {
    await Filesystem.rmdir({ path: `manga/${ep}`, directory: Directory.Data, recursive: true });
  } catch {
    /* already gone */
  }
  localStorage.removeItem(key(ep));
  clearMangaPage(ep);
}

export function loadLocalManga(ep: string): Promise<MangaDoc | null> {
  return readLocalJson<MangaDoc>(getMangaRecord(ep)?.docPath);
}

export function loadLocalMangaTranscript(ep: string): Promise<TranscriptDoc | null> {
  return readLocalJson<TranscriptDoc>(getMangaRecord(ep)?.transcriptPath);
}

export function loadLocalMangaDefinitions(ep: string): Promise<Definitions | null> {
  return readLocalJson<Definitions>(getMangaRecord(ep)?.defsPath);
}

/** A page scan's displayable URL: the app-internal file through the
    webview's file bridge (same as the player's local video). */
export async function pageImageSrc(ep: string, file: string): Promise<string> {
  const rec = getMangaRecord(ep);
  const { uri } = await Filesystem.getUri({
    path: `${rec?.pagesDir ?? `manga/${ep}/pages`}/${file}`,
    directory: Directory.Data,
  });
  return Capacitor.convertFileSrc(uri);
}

// --- reading time → a viewtime sitting ------------------------------------------------

/** Longest a single page can count for — a volume left open on the desk
    is not reading (the video recorder has the same guard by construction:
    it only counts while media plays). */
export const MAX_PAGE_SECS = 300;

export interface ReadRecorderOpts {
  episodeId: string;
  title: string;
  pageSecs: number;
  pageCount: number;
  now?: () => Date;
}

/** Accrues page views into one sitting (ViewSegment, kind "read" — the
    ledger credits exposures from its `played` ranges, page spans here).
    show(i) when a page comes on screen; pause()/resume() around the app
    going to the background; close() when leaving the reader. Lazy: the
    sitting opens on the first counted page, and a page that was on screen
    under a second is noise. */
export class ReadRecorder {
  private seg: ViewSegment | null = null;
  private page: number | null = null;
  private since: number | null = null; // ms when the current page came on screen
  private acc = 0; // seconds on the current page so far (across pauses)

  constructor(private readonly opts: ReadRecorderOpts) {}

  private nowMs(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private open(now: Date): ViewSegment {
    return {
      id: newId(),
      episode_id: this.opts.episodeId,
      title: this.opts.title,
      kind: "read",
      day: dayKey(now),
      start: now.toISOString(),
      secs: 0,
      reached: 0,
      duration: this.opts.pageCount * this.opts.pageSecs,
      played: [],
    };
  }

  /** Bank the current page's time into the sitting. */
  private settle(): void {
    if (this.page == null) return;
    if (this.since != null) {
      this.acc += (this.nowMs() - this.since) / 1000;
      this.since = null;
    }
    const secs = Math.min(this.acc, MAX_PAGE_SECS);
    this.acc = 0;
    if (secs < 1) return;
    const now = this.opts.now?.() ?? new Date();
    if (this.seg && this.seg.day !== dayKey(now)) this.flush(); // midnight: a new day's sitting
    if (!this.seg) this.seg = this.open(now);
    const from = this.page * this.opts.pageSecs;
    const to = from + this.opts.pageSecs;
    (this.seg.played ??= []).push([from, to]);
    this.seg.secs += secs;
    if (to > this.seg.reached) this.seg.reached = to;
    setOpenViewSegment(this.seg); // checkpoint: a process kill keeps what was read
  }

  /** Page `i` is on screen now. */
  show(i: number): void {
    if (i === this.page && this.since != null) return;
    this.settle();
    this.page = i;
    this.since = this.nowMs();
  }

  /** The app left the foreground — stop the clock, keep the page. */
  pause(): void {
    if (this.since != null && this.page != null) {
      this.acc += (this.nowMs() - this.since) / 1000;
      this.since = null;
    }
  }

  resume(): void {
    if (this.page != null && this.since == null) this.since = this.nowMs();
  }

  private flush(): void {
    const seg = this.seg;
    this.seg = null;
    setOpenViewSegment(null);
    if (!seg || seg.secs < 1) return;
    const played = mergeRanges(seg.played ?? []);
    recordViewSegment({
      ...seg,
      secs: Math.round(seg.secs * 10) / 10,
      ...(played.length ? { played } : {}),
    });
  }

  /** End the sitting: the open page is banked and the segment recorded. */
  close(): void {
    this.settle();
    this.page = null;
    this.since = null;
    this.flush();
  }

  get current(): ViewSegment | null {
    return this.seg;
  }
}
