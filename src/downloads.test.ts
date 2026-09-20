// Shared download state (downloads.ts): two downloads at once keep their own
// numbers on their own buttons, a button rebuilt mid-download paints the live
// status, and a settled download writes the VideoRecord for every view.
// Regression for: parallel ⬇ taps flickering between each other's progress
// (every button listened to the plugin-global progress event). The web
// fallback path is exercised here; on the phone the native service feeds the
// same state through the same setStatus/settle.
// Run: npx vitest run

import { beforeEach, describe, expect, it, vi } from "vitest";

type Progress = { url: string; bytes: number; contentLength: number };
const progressListeners = new Set<(p: Progress) => void>();
const server = new Map<string, () => Promise<void>>(); // url → controllable download
const files = new Map<string, string>();

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    downloadFile: vi.fn(async ({ url, path }: { url: string; path: string }) => {
      const plain = url.split("?")[0];
      const run = server.get(plain);
      if (!run) throw new Error(`404 ${plain}`);
      await run();
      files.set(path, "x");
    }),
    readFile: vi.fn(async ({ path }: { path: string }) => {
      if (!files.has(path)) throw new Error("ENOENT");
      return { data: files.get(path)! };
    }),
    deleteFile: vi.fn(async ({ path }: { path: string }) => void files.delete(path)),
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ size: 1 })),
    addListener: vi.fn(async (_: string, fn: (p: Progress) => void) => {
      progressListeners.add(fn);
      return { remove: () => progressListeners.delete(fn) };
    }),
  },
}));

vi.mock("./api", () => ({
  api: {
    videoUrl: (id: string) => `http://pc/video/${id}?t=tok`,
    subsUrl: (id: string) => `http://pc/video/${id}/subs?t=tok`,
    transcriptUrl: (id: string) => `http://pc/transcript/${id}`,
    definitionsUrl: (id: string) => `http://pc/definitions/${id}`,
    getPrep: async () => {
      throw new Error("no prep");
    },
  },
  ApiError: class extends Error {},
}));

import {
  activeDownloads,
  bindDownloadButton,
  downloadError,
  downloadLabel,
  downloadStatus,
  onDownloadChange,
  startDownload,
  watchDownloads,
} from "./downloads";
import { getVideoRecord } from "./video";

/** A server file whose download we complete by hand, emitting progress. */
function controllable(url: string) {
  let finish!: () => void;
  let fail!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    finish = res;
    fail = rej;
  });
  server.set(url, () => done);
  return {
    progress(bytes: number, contentLength: number) {
      for (const fn of [...progressListeners]) fn({ url: `${url}?t=tok`, bytes, contentLength });
    },
    finish,
    fail,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  files.clear();
  server.clear();
  progressListeners.clear();
});

describe("downloads", () => {
  it("keeps two simultaneous downloads' progress on their own buttons", async () => {
    const a = controllable("http://pc/video/epA");
    const b = controllable("http://pc/video/epB");
    const root = document.createElement("div");
    const btnA = bindDownloadButton(document.createElement("button"), { ep: "epA", idle: "⬇ video", prefix: "⬇" });
    const btnB = bindDownloadButton(document.createElement("button"), { ep: "epB", idle: "⬇ video", prefix: "⬇" });
    root.append(btnA, btnB);
    document.body.appendChild(root);
    watchDownloads(root);

    btnA.click();
    btnB.click();
    expect(btnA.textContent).toBe("⬇ queued");
    expect(btnB.textContent).toBe("⬇ queued");
    expect(btnA.disabled && btnB.disabled).toBe(true);
    await tick();
    // the web fallback serialises: A is transferring, B waits its turn
    expect(activeDownloads().sort()).toEqual(["epA", "epB"]);

    a.progress(25, 100);
    expect(btnA.textContent).toBe("⬇ 25%");
    expect(btnB.textContent).toBe("⬇ queued"); // B never saw A's bytes
    a.progress(50, 100);
    expect(btnA.textContent).toBe("⬇ 50%");
    expect(btnB.textContent).toBe("⬇ queued");

    a.finish();
    await tick();
    await tick();
    expect(getVideoRecord("epA")?.path).toBe("videos/epA.mp4");
    expect(downloadStatus("epA")).toBeNull();
    b.progress(10, 100);
    expect(btnB.textContent).toBe("⬇ 10%");
    b.finish();
    await tick();
    await tick();
    expect(getVideoRecord("epB")).not.toBeNull();
    expect(activeDownloads()).toEqual([]);
    root.remove();
  });

  it("a button built mid-download paints the live status (list rebuilt by the poll)", async () => {
    const a = controllable("http://pc/video/epC");
    await startDownload("epC");
    await tick();
    a.progress(40, 100);
    const rebuilt = bindDownloadButton(document.createElement("button"), { ep: "epC", idle: "⬇ video", prefix: "⬇" });
    expect(rebuilt.textContent).toBe("⬇ 40%");
    expect(rebuilt.disabled).toBe(true);
    a.finish();
    await tick();
    await tick();
    expect(getVideoRecord("epC")).not.toBeNull();
  });

  it("a failed download settles with its error and the button offers a retry", async () => {
    const a = controllable("http://pc/video/epD");
    const changes: (string | null)[] = [];
    const off = onDownloadChange((c) => changes.push(c.status ? "live" : (c.error ?? null)));
    await startDownload("epD");
    await tick();
    a.fail(new Error("connection reset"));
    await tick();
    await tick();
    off();
    expect(downloadStatus("epD")).toBeNull();
    expect(downloadError("epD")).toBe("connection reset");
    expect(changes.at(-1)).toBe("connection reset");
    expect(getVideoRecord("epD")).toBeNull();
    const btn = bindDownloadButton(document.createElement("button"), { ep: "epD", idle: "⬇ video", prefix: "⬇" });
    expect(btn.textContent).toBe("⬇ retry");
    expect(btn.disabled).toBe(false);
  });

  it("startDownload is a no-op while the episode is already active", async () => {
    controllable("http://pc/video/epE");
    await startDownload("epE");
    await startDownload("epE");
    expect(activeDownloads()).toEqual(["epE"]);
  });

  it("labels: queued / percent / bytes-only / finishing", () => {
    expect(downloadLabel({ phase: "queued", bytes: 0, total: null })).toBe("⬇ queued");
    expect(downloadLabel({ phase: "video", bytes: 50, total: 200 }, "↻")).toBe("↻ 25%");
    expect(downloadLabel({ phase: "video", bytes: 12_400_000, total: null })).toBe("⬇ 12 MB");
    expect(downloadLabel({ phase: "sidecars", bytes: 1, total: 1 })).toBe("⬇ finishing…");
  });
});
