// Sidecar refresh: videos are usually downloaded at `prepared`, before
// curation — refreshSidecars re-pulls the transcript/definitions once the
// curate pass has landed so grammar/phrase notes reach the player.
// Run: npx vitest run

import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const server = new Map<string, string>(); // url → body ("" entries 404)

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

import { loadLocalTranscript, refreshSidecars, getVideoRecord } from "./video";
import { saveSettings } from "./store";

const EP = "yt_test123";
const T_URL = `http://pc:8000/transcript/${EP}`;
const D_URL = `http://pc:8000/definitions/${EP}`;
const preCurate = { episode_id: EP, curated: false, sentences: [{ idx: 0, start: 0, end: 1, tokens: [] }] };
const postCurate = {
  episode_id: EP,
  curated: true,
  sentences: [{ idx: 0, start: 0, end: 1, tokens: [], grammar: [{ pattern: "〜てしまう" }] }],
};

beforeEach(() => {
  localStorage.clear();
  files.clear();
  server.clear();
  saveSettings({ serverUrl: "http://pc:8000", token: "" });
  files.set(`videos/${EP}.transcript.json`, JSON.stringify(preCurate));
  localStorage.setItem(
    `fp.video.${EP}`,
    JSON.stringify({
      path: `videos/${EP}.mp4`,
      transcriptPath: `videos/${EP}.transcript.json`,
      size: 1,
      at: "2026-01-01",
    }),
  );
});

describe("refreshSidecars", () => {
  it("replaces a pre-curation sidecar and flags the record curated", async () => {
    server.set(T_URL, JSON.stringify(postCurate));
    server.set(D_URL, JSON.stringify({ 切ない: [{ k: ["切ない"], r: ["せつない"], s: [] }] }));
    const doc = await refreshSidecars(EP);
    expect(doc?.curated).toBe(true);
    expect(doc?.sentences[0].grammar?.[0].pattern).toBe("〜てしまう");
    expect(getVideoRecord(EP)?.curated).toBe(true);
    const local = await loadLocalTranscript(EP);
    expect(local?.curated).toBe(true);
    expect(files.has(`videos/${EP}.definitions.json`)).toBe(true);
  });

  it("keeps the old sidecar when the server is unreachable", async () => {
    const doc = await refreshSidecars(EP); // nothing on the mock server → 404
    expect(doc).toBeNull();
    expect(getVideoRecord(EP)?.curated).toBeFalsy();
    expect((await loadLocalTranscript(EP))?.sentences.length).toBe(1);
  });

  it("keeps the old sidecar when the fresh download is empty/garbled", async () => {
    server.set(T_URL, "not json");
    const doc = await refreshSidecars(EP);
    expect(doc).toBeNull();
    expect((await loadLocalTranscript(EP))?.curated).toBe(false);
  });

  it("is a no-op once the record is curated", async () => {
    server.set(T_URL, JSON.stringify(postCurate));
    server.set(D_URL, "{}");
    await refreshSidecars(EP);
    server.clear(); // a second call must not even hit the network
    expect(await refreshSidecars(EP)).toBeNull();
    expect(getVideoRecord(EP)?.curated).toBe(true);
  });

  it("is a no-op without a downloaded video", async () => {
    localStorage.clear();
    saveSettings({ serverUrl: "http://pc:8000", token: "" });
    expect(await refreshSidecars(EP)).toBeNull();
  });
});
