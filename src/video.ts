// Episode video: download-then-play (MOBILE.md decoupled pulls — manual
// trigger for now, WorkManager later). Files land in app-internal storage
// (videos/<episode>.mp4 + .srt sidecar) and are handed to an external player
// (VLC) as content:// grants via the ExternalPlayer plugin. Deleted at
// mark-watched.

import { registerPlugin } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { api } from "./api";
import { getSettings } from "./store";

interface ExternalPlayerPlugin {
  play(opts: { video: string; subs?: string; title?: string }): Promise<void>;
}
const ExternalPlayer = registerPlugin<ExternalPlayerPlugin>("ExternalPlayer");

export interface VideoRecord {
  path: string;
  subsPath?: string;
  size: number;
  at: string;
}

const key = (ep: string) => `fp.video.${ep}`;

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
    const stat = await Filesystem.stat({ path: vPath, directory: Directory.Data });
    const rec: VideoRecord = {
      path: vPath,
      subsPath,
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
    for (const p of [rec.path, rec.subsPath]) {
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
