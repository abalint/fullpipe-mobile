// Episode downloads as one shared piece of state, not a closure per button.
//
// Before this, every ⬇ button ran Filesystem.downloadFile itself and painted
// its own progress from a *global* progress listener — so two downloads at
// once showed each other's numbers on both buttons, a queue re-render (the
// 2.5 s poll) threw the live button away, and leaving the tab or the app
// killed the pull with the webview. Now:
//
//   • on the phone the native VideoDownloadService (foreground, notification,
//     wake lock) does the transfer and survives backgrounding; results wait
//     natively until we've written the VideoRecord and acked them, so a
//     download that finished while the webview was gone is picked up on the
//     next open (reconcile);
//   • this module mirrors "what's downloading right now" for every view — a
//     button reads its own episode's status when it's built, and a single
//     subscription per view repaints buttons by episode id as progress lands;
//   • on the web build (dev / tests) the in-webview path in video.ts is used,
//     serialised, feeding the same state.

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { api } from "./api";
import { getSettings } from "./store";
import { downloadVideo, finalizeVideoRecord, videoPaths } from "./video";

export type DownloadPhase = "queued" | "video" | "sidecars";

export interface DownloadStatus {
  phase: DownloadPhase;
  bytes: number;
  total: number | null; // null until the server says (or never, chunked)
}

export interface DownloadChange {
  ep: string;
  /** Live status, or null when the download settled (done or failed). */
  status: DownloadStatus | null;
  error?: string;
}

interface NativeResult {
  episodeId: string;
  ok: boolean;
  error?: string;
  files?: Record<string, boolean>;
}

interface VideoDownloadPlugin {
  enqueue(opts: {
    episodeId: string;
    title: string;
    files: { url: string; path: string; required: boolean }[];
    headers?: Record<string, string>;
  }): Promise<{ queued: boolean }>;
  getState(): Promise<{
    active: { episodeId: string; bytes: number; total: number; phase: DownloadPhase }[];
    results: NativeResult[];
  }>;
  ack(opts: { episodeIds: string[] }): Promise<void>;
  addListener(
    eventName: "progress",
    fn: (p: { episodeId: string; bytes: number; total: number; phase: DownloadPhase }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(eventName: "done", fn: (r: NativeResult) => void): Promise<PluginListenerHandle>;
}

const Native = registerPlugin<VideoDownloadPlugin>("VideoDownload");
const native = () => Capacitor.isNativePlatform();

const active = new Map<string, DownloadStatus>();
const errors = new Map<string, string>();
const listeners = new Set<(c: DownloadChange) => void>();

function emit(c: DownloadChange): void {
  for (const fn of [...listeners]) {
    try {
      fn(c);
    } catch {
      /* a view's handler must never break the others */
    }
  }
}

export function downloadStatus(ep: string): DownloadStatus | null {
  return active.get(ep) ?? null;
}

/** Why the last attempt failed (cleared when a retry starts). */
export function downloadError(ep: string): string | null {
  return errors.get(ep) ?? null;
}

export function activeDownloads(): string[] {
  return [...active.keys()];
}

export function onDownloadChange(fn: (c: DownloadChange) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Button text for a live download: "⬇ queued" · "⬇ 42%" · "⬇ 12 MB" (no
    length known) · "⬇ finishing…" (sidecars). */
export function downloadLabel(s: DownloadStatus, prefix = "⬇"): string {
  if (s.phase === "queued") return `${prefix} queued`;
  if (s.phase === "sidecars") return `${prefix} finishing…`;
  if (s.total && s.total > 0) return `${prefix} ${Math.min(100, Math.round((s.bytes / s.total) * 100))}%`;
  return `${prefix} ${Math.round(s.bytes / 1e6)} MB`;
}

function setStatus(ep: string, s: DownloadStatus): void {
  active.set(ep, s);
  emit({ ep, status: s });
}

async function settle(ep: string, ok: boolean, error?: string, files?: Record<string, boolean>): Promise<void> {
  active.delete(ep);
  if (ok) {
    const { sPath, tPath, dPath } = videoPaths(ep);
    const has = (p: string) => (files ? !!files[p] : true);
    try {
      await finalizeVideoRecord(ep, {
        subsPath: has(sPath) ? sPath : undefined,
        transcriptPath: has(tPath) ? tPath : undefined,
        defsPath: has(dPath) ? dPath : undefined,
      });
      errors.delete(ep);
    } catch (e) {
      ok = false;
      error = (e as Error).message;
    }
  }
  if (!ok) errors.set(ep, error || "download failed");
  emit({ ep, status: null, error: ok ? undefined : error || "download failed" });
}

// web fallback: one at a time through the in-webview path, so parallel taps
// don't compete for bandwidth any more than the native queue would
let chain: Promise<void> = Promise.resolve();

/** Start (or queue) an episode's download. Resolves once it's queued — the
    outcome arrives through onDownloadChange / downloadStatus, so a view that
    has since been rebuilt still sees it. A no-op while it's already active. */
export async function startDownload(ep: string, title?: string): Promise<void> {
  if (active.has(ep)) return;
  errors.delete(ep);
  setStatus(ep, { phase: "queued", bytes: 0, total: null });
  if (native()) {
    const { token } = getSettings();
    const { vPath, sPath, tPath, dPath } = videoPaths(ep);
    try {
      await Native.enqueue({
        episodeId: ep,
        title: title || ep,
        files: [
          { url: api.videoUrl(ep), path: vPath, required: true },
          { url: api.subsUrl(ep), path: sPath, required: false },
          { url: api.transcriptUrl(ep), path: tPath, required: false },
          { url: api.definitionsUrl(ep), path: dPath, required: false },
        ],
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (e) {
      await settle(ep, false, (e as Error).message);
    }
    return;
  }
  chain = chain.then(async () => {
    if (!active.has(ep)) return; // settled meanwhile (can't happen today; defensive)
    try {
      await downloadVideo(ep, (frac, bytes) =>
        setStatus(ep, {
          phase: "video",
          bytes,
          total: frac != null && frac > 0 ? Math.round(bytes / frac) : null,
        }),
      );
      await settle(ep, true);
    } catch (e) {
      await settle(ep, false, (e as Error).message);
    }
  });
}

/** Catch up with the native queue: what's in flight right now, and results
    that finished while the webview was paused or dead. Idempotent. */
export async function reconcileDownloads(): Promise<void> {
  if (!native()) return;
  let state: Awaited<ReturnType<VideoDownloadPlugin["getState"]>>;
  try {
    state = await Native.getState();
  } catch {
    return;
  }
  const live = new Set(state.active.map((a) => a.episodeId));
  for (const a of state.active)
    setStatus(a.episodeId, { phase: a.phase, bytes: a.bytes, total: a.total > 0 ? a.total : null });
  const acked: string[] = [];
  for (const r of state.results) {
    live.delete(r.episodeId);
    await settle(r.episodeId, r.ok, r.error, r.files);
    acked.push(r.episodeId);
  }
  // anything we thought was active but the service no longer has (process
  // died mid-transfer, no result recorded) — let the button come back
  for (const ep of [...active.keys()])
    if (!live.has(ep) && !state.active.some((a) => a.episodeId === ep) && !acked.includes(ep))
      await settle(ep, false, "interrupted — tap to resume");
  if (acked.length) await Native.ack({ episodeIds: acked }).catch(() => {});
}

let installed = false;

/** Wire the native events once at boot (main.ts) and reconcile now + every
    time the app returns to the foreground. */
export function installDownloads(): void {
  if (installed || !native()) return;
  installed = true;
  void Native.addListener("progress", (p) =>
    setStatus(p.episodeId, { phase: p.phase, bytes: p.bytes, total: p.total > 0 ? p.total : null }),
  );
  void Native.addListener("done", (r) => {
    void settle(r.episodeId, r.ok, r.error, r.files).then(() =>
      Native.ack({ episodeIds: [r.episodeId] }).catch(() => {}),
    );
  });
  void reconcileDownloads();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void reconcileDownloads();
  });
}

// --- DOM helpers shared by the queue / Listen / series buttons ------------

export interface DownloadButtonOpts {
  ep: string;
  /** Notification title (the job's title). */
  title?: string;
  /** Resting label, e.g. "⬇ video", "↻", "⬇ E03". */
  idle: string;
  /** Prefix for the live label; defaults to `idle`. */
  prefix?: string;
}

/** Make `btn` this episode's download button: paints the live status when
    it's built (so a re-render mid-download shows the right number), tags it
    with data-dl so watchDownloads can repaint it, and starts the download
    on tap. */
export function bindDownloadButton(btn: HTMLButtonElement, o: DownloadButtonOpts): HTMLButtonElement {
  const prefix = o.prefix ?? o.idle;
  btn.dataset.dl = o.ep;
  btn.dataset.dlPrefix = prefix;
  const paint = () => {
    const s = downloadStatus(o.ep);
    btn.disabled = !!s;
    const err = downloadError(o.ep);
    btn.textContent = s ? downloadLabel(s, prefix) : err ? `${prefix} retry` : o.idle;
    if (err && !s) btn.title = `download failed: ${err}`;
  };
  paint();
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    void startDownload(o.ep, o.title);
    paint();
  });
  return btn;
}

/** One subscription per view: repaints every data-dl button under `root`
    for the episode that moved, then hands the change to the view (a settled
    download usually means "rebuild the list"). Unsubscribes itself once the
    view has been swapped out. */
export function watchDownloads(root: HTMLElement, onChange?: (c: DownloadChange) => void): () => void {
  const off = onDownloadChange((c) => {
    if (!root.isConnected) return off();
    root.querySelectorAll<HTMLButtonElement>("button[data-dl]").forEach((b) => {
      if (b.dataset.dl !== c.ep) return;
      if (c.status) {
        b.disabled = true;
        b.textContent = downloadLabel(c.status, b.dataset.dlPrefix || "⬇");
      }
    });
    onChange?.(c);
  });
  return off;
}
