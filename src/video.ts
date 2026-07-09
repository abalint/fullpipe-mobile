// Episode video: download-then-play (MOBILE.md decoupled pulls — manual
// trigger for now, WorkManager later). Files land in app-internal storage
// (videos/<episode>.mp4 + .srt sidecar) and play in the in-app player.
// Retained after mark-watched (for rewatch + passive listening) — deletion is
// manual only: swipe-delete on a queue/Listen row (deleteVideo), never
// automatic at close-out.

import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { api } from "./api";
import { cachePrep, getSettings } from "./store";
import type { Definitions, TranscriptDoc } from "./types";

export interface VideoRecord {
  path: string;
  subsPath?: string;
  transcriptPath?: string; // tokenized sentence track (absent on old records)
  defsPath?: string; // per-episode JMdict definitions (absent on old records)
  curated?: boolean; // sidecars carry the curate pass (grammar/phrases/defs);
  // false/absent → refreshSidecars retries once curation lands
  size: number;
  at: string;
}

const key = (ep: string) => `fp.video.${ep}`;
const posKey = (ep: string) => `fp.pos.${ep}`;

/** Resume position, seconds. Cleared with the video / at mark-watched. */
export function getPosition(ep: string): number | null {
  const raw = localStorage.getItem(posKey(ep));
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function savePosition(ep: string, seconds: number): void {
  localStorage.setItem(posKey(ep), String(seconds));
}

export function clearPosition(ep: string): void {
  localStorage.removeItem(posKey(ep));
}

export function getVideoRecord(ep: string): VideoRecord | null {
  try {
    const raw = localStorage.getItem(key(ep));
    return raw ? (JSON.parse(raw) as VideoRecord) : null;
  } catch {
    return null;
  }
}

export function downloadedEpisodes(): { ep: string; rec: VideoRecord }[] {
  const out: { ep: string; rec: VideoRecord }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith("fp.video.")) {
      const rec = getVideoRecord(k.slice("fp.video.".length));
      if (rec) out.push({ ep: k.slice("fp.video.".length), rec });
    }
  }
  return out;
}

async function ensureVideosDir(): Promise<void> {
  try {
    await Filesystem.mkdir({ path: "videos", directory: Directory.Data, recursive: true });
  } catch {
    /* already exists */
  }
}

export async function downloadVideo(
  ep: string,
  onProgress?: (fraction: number | null, bytes: number) => void,
): Promise<VideoRecord> {
  const { token } = getSettings();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const vPath = `videos/${ep}.mp4`;
  const sPath = `videos/${ep}.srt`;
  const tPath = `videos/${ep}.transcript.json`;
  const dPath = `videos/${ep}.definitions.json`;
  // downloadFile doesn't create parent dirs despite recursive:true (ENOENT)
  await ensureVideosDir();

  const listener = onProgress
    ? await Filesystem.addListener("progress", (p) => {
        onProgress(p.contentLength ? p.bytes / p.contentLength : null, p.bytes);
      })
    : null;
  try {
    await Filesystem.downloadFile({
      url: api.videoUrl(ep),
      headers,
      path: vPath,
      directory: Directory.Data,
      recursive: true,
      progress: !!onProgress,
    });
    let subsPath: string | undefined;
    try {
      await Filesystem.downloadFile({
        url: api.subsUrl(ep),
        headers,
        path: sPath,
        directory: Directory.Data,
        recursive: true,
      });
      subsPath = sPath;
    } catch {
      /* subs are best-effort */
    }
    // tokenized sentence track for the in-app player (best-effort like subs —
    // without it the player falls back to plain SRT cues)
    let transcriptPath: string | undefined;
    try {
      await Filesystem.downloadFile({
        url: api.transcriptUrl(ep),
        headers,
        path: tPath,
        directory: Directory.Data,
        recursive: true,
      });
      transcriptPath = tPath;
    } catch {
      /* transcript is best-effort */
    }
    // per-episode dictionary for the any-word popup (best-effort; {} until
    // the PC has built jmdict.db)
    let defsPath: string | undefined;
    try {
      await Filesystem.downloadFile({
        url: api.definitionsUrl(ep),
        headers,
        path: dPath,
        directory: Directory.Data,
        recursive: true,
      });
      defsPath = dPath;
    } catch {
      /* definitions are best-effort */
    }
    // prep article into the same offline bundle (localStorage cache — the prep
    // view reads it there). At `prepared` this is the uncurated doc; the queue
    // screen re-caches once curation lands (staged), and the prep view
    // refreshes it on any online open.
    try {
      cachePrep(await api.getPrep(ep));
    } catch {
      /* prep is best-effort */
    }
    const stat = await Filesystem.stat({ path: vPath, directory: Directory.Data });
    const rec: VideoRecord = {
      path: vPath,
      subsPath,
      transcriptPath,
      defsPath,
      curated: transcriptPath
        ? ((await readLocalJson<TranscriptDoc>(transcriptPath))?.curated ?? false)
        : false,
      size: stat.size,
      at: new Date().toISOString(),
    };
    localStorage.setItem(key(ep), JSON.stringify(rec));
    return rec;
  } finally {
    void listener?.remove();
  }
}

/** Re-download the transcript + definitions sidecars. Videos are usually
    downloaded at `prepared`, before /immerse has curated — so the sidecars
    lack grammar/phrase notes and the curate-authored definitions until this
    runs. Called once curation lands (queue refresh / player open); a no-op
    when the record is already curated. Returns the fresh transcript, or null
    when nothing was refreshed (no record, offline, still uncurated). */
export async function refreshSidecars(ep: string): Promise<TranscriptDoc | null> {
  const rec = getVideoRecord(ep);
  if (!rec || rec.curated) return null;
  const { token } = getSettings();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  // stage into .fresh then swap, so a failed download can't truncate the
  // sidecar the player is falling back on
  const tPath = `videos/${ep}.transcript.json`;
  try {
    await Filesystem.downloadFile({
      url: api.transcriptUrl(ep),
      headers,
      path: `${tPath}.fresh`,
      directory: Directory.Data,
      recursive: true,
    });
  } catch {
    return null; // offline / purged server-side — retry on a later trigger
  }
  const doc = await readLocalJson<TranscriptDoc>(`${tPath}.fresh`);
  if (!doc?.sentences?.length) return null;
  await Filesystem.rename({
    from: `${tPath}.fresh`,
    to: tPath,
    directory: Directory.Data,
    toDirectory: Directory.Data,
  });
  const dPath = `videos/${ep}.definitions.json`;
  try {
    await Filesystem.downloadFile({
      url: api.definitionsUrl(ep),
      headers,
      path: dPath,
      directory: Directory.Data,
      recursive: true,
    });
  } catch {
    /* definitions are best-effort, same as at download time */
  }
  localStorage.setItem(
    key(ep),
    JSON.stringify({
      ...rec,
      transcriptPath: tPath,
      defsPath: dPath,
      curated: doc.curated ?? false,
    }),
  );
  return doc;
}

export async function deleteVideo(ep: string): Promise<void> {
  const rec = getVideoRecord(ep);
  if (rec) {
    for (const p of [rec.path, rec.subsPath, rec.transcriptPath, rec.defsPath]) {
      if (!p) continue;
      try {
        await Filesystem.deleteFile({ path: p, directory: Directory.Data });
      } catch {
        /* already gone */
      }
    }
  }
  localStorage.removeItem(key(ep));
  clearPosition(ep);
}

async function readLocalJson<T>(path: string | undefined): Promise<T | null> {
  if (!path) return null;
  try {
    const { data } = await Filesystem.readFile({
      path,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return JSON.parse(data as string) as T;
  } catch {
    return null;
  }
}

/** The downloaded tokenized track, or null when absent/unreadable (older
    download, endpoint missing) — the player then falls back to SRT. */
export function loadLocalTranscript(ep: string): Promise<TranscriptDoc | null> {
  return readLocalJson<TranscriptDoc>(getVideoRecord(ep)?.transcriptPath);
}

/** The downloaded per-episode dictionary, or null (older download / no db). */
export function loadLocalDefinitions(ep: string): Promise<Definitions | null> {
  return readLocalJson<Definitions>(getVideoRecord(ep)?.defsPath);
}

export function fmtSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}
