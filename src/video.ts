// Episode video: download-then-play (MOBILE.md decoupled pulls — manual
// trigger for now, WorkManager later). Files land in app-internal storage
// (videos/<episode>.mp4 + .srt sidecar) and are handed to an external player
// (VLC) as content:// grants via the ExternalPlayer plugin. Deleted at
// mark-watched — unless the episode is shelved for passive listening ("keep to
// listen"), which pins the file so its audio plays straight off the device.

import { registerPlugin } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { api } from "./api";
import { cachePrep, getSettings } from "./store";
import type { Definitions, TranscriptDoc } from "./types";

interface ExternalPlayerPlugin {
  play(opts: { video: string; subs?: string; title?: string }): Promise<void>;
}
const ExternalPlayer = registerPlugin<ExternalPlayerPlugin>("ExternalPlayer");

export interface VideoRecord {
  path: string;
  subsPath?: string;
  transcriptPath?: string; // tokenized sentence track (absent on old records)
  defsPath?: string; // per-episode JMdict definitions (absent on old records)
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
      size: stat.size,
      at: new Date().toISOString(),
    };
    localStorage.setItem(key(ep), JSON.stringify(rec));
    return rec;
  } finally {
    void listener?.remove();
  }
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
    download, endpoint missing) — the player then falls back to SRT/stream. */
export function loadLocalTranscript(ep: string): Promise<TranscriptDoc | null> {
  return readLocalJson<TranscriptDoc>(getVideoRecord(ep)?.transcriptPath);
}

/** The downloaded per-episode dictionary, or null (older download / no db). */
export function loadLocalDefinitions(ep: string): Promise<Definitions | null> {
  return readLocalJson<Definitions>(getVideoRecord(ep)?.defsPath);
}

/** Launch the downloaded episode in VLC (or whatever handles video/mp4). */
export async function playVideo(ep: string, title?: string): Promise<void> {
  const rec = getVideoRecord(ep);
  if (!rec) throw new Error("video not downloaded");
  const video = await Filesystem.getUri({ path: rec.path, directory: Directory.Data });
  const subs = rec.subsPath
    ? await Filesystem.getUri({ path: rec.subsPath, directory: Directory.Data })
    : null;
  await ExternalPlayer.play({ video: video.uri, subs: subs?.uri, title });
}

export function fmtSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}
