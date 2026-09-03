// Page bundles: the Pages tab's download-then-read counterpart to video.ts.
// A page job stages three small JSON artifacts (post structure, tokenized
// sentence track, per-page dictionary); all three land in app-internal
// storage (pages/<episode>.*) so a downloaded thread reads fully offline.
// Throwaway like everything else: swipe-delete on the Pages row removes the
// files here and the artifacts server-side; ledger evidence stays.

import { Directory, Filesystem } from "@capacitor/filesystem";
import { api } from "./api";
import { getSettings } from "./store";
import { readLocalJson } from "./video";
import type { Definitions, PageDoc, TranscriptDoc } from "./types";

/** A 5ch thread URL (itest or classic, .net or .io) — the sources the server
    routes into a page job. Must stay in lockstep with tools/pages.py. */
export function isPageSource(url: string): boolean {
  return /^https?:\/\/(?:itest\.5ch\.(?:net|io)\/[a-z0-9]+|[a-z0-9]+\.5ch\.(?:net|io))\/test\/read\.cgi\/[A-Za-z0-9_]+\/\d+/.test(
    url.trim(),
  );
}

export interface PageRecord {
  pagePath: string;
  transcriptPath: string;
  defsPath?: string;
  /** The /immerse page pass has run — defs carry its authored entries; while
      false the reader refreshes the sidecars on each online open. */
  curated?: boolean;
  title?: string;
  postCount?: number;
  at: string;
}

const key = (ep: string) => `fp.page.${ep}`;

export function getPageRecord(ep: string): PageRecord | null {
  try {
    const raw = localStorage.getItem(key(ep));
    return raw ? (JSON.parse(raw) as PageRecord) : null;
  } catch {
    return null;
  }
}

async function ensurePagesDir(): Promise<void> {
  try {
    await Filesystem.mkdir({ path: "pages", directory: Directory.Data, recursive: true });
  } catch {
    /* already exists */
  }
}

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

/** Pull the page bundle. Post structure + tokenized sentences are required
    (the reader is useless without them); definitions are best-effort ({}
    until the PC has built jmdict.db). */
export async function downloadPage(ep: string): Promise<PageRecord> {
  await ensurePagesDir();
  const pagePath = `pages/${ep}.page.json`;
  const transcriptPath = `pages/${ep}.transcript.json`;
  const defsPath = `pages/${ep}.definitions.json`;
  await download(api.pageUrl(ep), pagePath);
  await download(api.transcriptUrl(ep), transcriptPath);
  let gotDefs = false;
  try {
    await download(api.definitionsUrl(ep), defsPath);
    gotDefs = true;
  } catch {
    /* definitions are best-effort */
  }
  const doc = await readLocalJson<PageDoc>(pagePath);
  const transcript = await readLocalJson<TranscriptDoc>(transcriptPath);
  const rec: PageRecord = {
    pagePath,
    transcriptPath,
    defsPath: gotDefs ? defsPath : undefined,
    curated: transcript?.curated ?? false,
    title: doc?.title,
    postCount: doc?.post_count,
    at: new Date().toISOString(),
  };
  localStorage.setItem(key(ep), JSON.stringify(rec));
  return rec;
}

/** Re-pull the transcript + definitions once the /immerse page pass has
    enriched them (curate-authored defs for 5ch slang, name notes). No-op when
    already curated; returns the fresh transcript, else null. Mirrors
    video.ts refreshSidecars, staged-then-swap and all. */
export async function refreshPageSidecars(ep: string): Promise<TranscriptDoc | null> {
  const rec = getPageRecord(ep);
  if (!rec || rec.curated) return null;
  const tPath = rec.transcriptPath;
  try {
    await download(api.transcriptUrl(ep), `${tPath}.fresh`);
  } catch {
    return null; // offline / purged server-side — retry on a later open
  }
  const doc = await readLocalJson<TranscriptDoc>(`${tPath}.fresh`);
  if (!doc?.sentences?.length) return null;
  await Filesystem.rename({
    from: `${tPath}.fresh`,
    to: tPath,
    directory: Directory.Data,
    toDirectory: Directory.Data,
  });
  const defsPath = `pages/${ep}.definitions.json`;
  let gotDefs = !!rec.defsPath;
  try {
    await download(api.definitionsUrl(ep), defsPath);
    gotDefs = true;
  } catch {
    /* best-effort, same as at download time */
  }
  localStorage.setItem(
    key(ep),
    JSON.stringify({
      ...rec,
      defsPath: gotDefs ? defsPath : undefined,
      curated: doc.curated ?? false,
    }),
  );
  return doc;
}

export async function deletePageFiles(ep: string): Promise<void> {
  const rec = getPageRecord(ep);
  if (rec) {
    for (const p of [rec.pagePath, rec.transcriptPath, rec.defsPath]) {
      if (!p) continue;
      try {
        await Filesystem.deleteFile({ path: p, directory: Directory.Data });
      } catch {
        /* already gone */
      }
    }
  }
  localStorage.removeItem(key(ep));
}

export function loadLocalPage(ep: string): Promise<PageDoc | null> {
  return readLocalJson<PageDoc>(getPageRecord(ep)?.pagePath);
}

export function loadLocalPageTranscript(ep: string): Promise<TranscriptDoc | null> {
  return readLocalJson<TranscriptDoc>(getPageRecord(ep)?.transcriptPath);
}

export function loadLocalPageDefinitions(ep: string): Promise<Definitions | null> {
  return readLocalJson<Definitions>(getPageRecord(ep)?.defsPath);
}
