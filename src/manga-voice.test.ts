// The voice track on the phone: downloadMangaVoice pulls the index (404 =
// no track) + the clips not on disk, records the render it holds, and
// re-pulls when the PC renders anew.
// Run: npx vitest run

import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const server = new Map<string, string>(); // url (no query) → body
const dirs: string[] = [];

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    downloadFile: vi.fn(async ({ url, path }: { url: string; path: string }) => {
      const body = server.get(url.split("?")[0]);
      if (body === undefined) throw new Error("404");
      files.set(path, body);
    }),
    writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => void files.set(path, data)),
    readFile: vi.fn(async ({ path }: { path: string }) => {
      if (!files.has(path)) throw new Error("ENOENT");
      return { data: files.get(path)! };
    }),
    stat: vi.fn(async ({ path }: { path: string }) => {
      if (!files.has(path)) throw new Error("ENOENT");
      return { size: 1 };
    }),
    mkdir: vi.fn(async ({ path }: { path: string }) => void dirs.push(path)),
    rmdir: vi.fn(async ({ path }: { path: string }) => {
      for (const k of [...files.keys()]) if (k.startsWith(path + "/")) files.delete(k);
    }),
    getUri: vi.fn(async ({ path }: { path: string }) => ({ uri: `file:///data/${path}` })),
    addListener: vi.fn(async () => ({ remove: () => {} })),
  },
}));
vi.mock("@capacitor/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@capacitor/core")>()),
  Capacitor: { convertFileSrc: (u: string) => u.replace("file://", "capacitor://"), isNativePlatform: () => false },
}));

import { downloadMangaVoice, getMangaRecord, loadLocalMangaVoice, voiceClipSrc } from "./manga";
import { saveSettings } from "./store";

const EP = "manga_dandadan_v02";
const V_URL = `http://pc:8000/manga/${EP}/voice`;
const index = (built: string, clips = ["001_2.mp3", "001_0.mp3"]) => ({
  episode_id: EP, built_at: built, model: "eleven_v3",
  clips: clips.map((file, i) => ({ file, page: 0, k: i, sents: [i], speaker: "モモ", ms: 900 })),
});

beforeEach(() => {
  localStorage.clear();
  files.clear();
  server.clear();
  dirs.length = 0;
  saveSettings({ serverUrl: "http://pc:8000", token: "tok" });
  localStorage.setItem(`fp.manga.${EP}`, JSON.stringify({
    docPath: `manga/${EP}/manga.json`, transcriptPath: `manga/${EP}/transcript.json`,
    pagesDir: `manga/${EP}/pages`, pageCount: 2, pagesDownloaded: 2, at: "2026-10-04",
  }));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = server.get(url.split("?")[0]);
    return {
      ok: body !== undefined, status: body === undefined ? 404 : 200,
      statusText: body === undefined ? "Not Found" : "OK",
      json: async () => JSON.parse(body!), text: async () => body ?? "",
    } as unknown as Response;
  }));
});

describe("downloadMangaVoice", () => {
  it("no track on the PC → null, record untouched", async () => {
    expect(await downloadMangaVoice(EP)).toBeNull();
    expect(getMangaRecord(EP)?.voicePath).toBeUndefined();
  });

  it("pulls the index and every clip, then is a no-op for the same render", async () => {
    server.set(V_URL, JSON.stringify(index("2026-10-04T10:00:00")));
    server.set(`${V_URL}/001_2.mp3`, "MP3-A");
    server.set(`${V_URL}/001_0.mp3`, "MP3-B");
    const seen: [number, number][] = [];
    const idx = await downloadMangaVoice(EP, (d, t) => void seen.push([d, t]));
    expect(idx?.clips).toHaveLength(2);
    expect(files.get(`manga/${EP}/voice/001_2.mp3`)).toBe("MP3-A");
    expect(seen).toEqual([[0, 2], [1, 2], [2, 2]]);
    const rec = getMangaRecord(EP)!;
    expect(rec.voiceBuiltAt).toBe("2026-10-04T10:00:00");
    expect(rec.voiceClips).toBe(2);
    expect(rec.pageCount).toBe(2); // the rest of the record survives
    expect((await loadLocalMangaVoice(EP))?.clips[0].file).toBe("001_2.mp3");
    expect(await voiceClipSrc(EP, "001_2.mp3")).toBe(`capacitor:///data/manga/${EP}/voice/001_2.mp3`);
    // same render again: one GET, no clip traffic
    const dl = (await import("@capacitor/filesystem")).Filesystem.downloadFile as unknown as { mock: { calls: unknown[] } };
    const before = dl.mock.calls.length;
    await downloadMangaVoice(EP);
    expect(dl.mock.calls.length).toBe(before);
  });

  it("a new render replaces the old clips", async () => {
    server.set(V_URL, JSON.stringify(index("2026-10-04T10:00:00")));
    server.set(`${V_URL}/001_2.mp3`, "MP3-A");
    server.set(`${V_URL}/001_0.mp3`, "MP3-B");
    await downloadMangaVoice(EP);
    server.set(V_URL, JSON.stringify(index("2026-10-05T10:00:00", ["001_2.mp3"])));
    server.set(`${V_URL}/001_2.mp3`, "MP3-A2");
    const idx = await downloadMangaVoice(EP);
    expect(idx?.clips).toHaveLength(1);
    expect(files.get(`manga/${EP}/voice/001_2.mp3`)).toBe("MP3-A2"); // re-fetched, not kept
    expect(files.has(`manga/${EP}/voice/001_0.mp3`)).toBe(false);
    expect(getMangaRecord(EP)?.voiceClips).toBe(1);
  });

  it("a clip that fails to download leaves a resumable record", async () => {
    server.set(V_URL, JSON.stringify(index("2026-10-04T10:00:00")));
    server.set(`${V_URL}/001_2.mp3`, "MP3-A"); // 001_0 missing on the server
    await expect(downloadMangaVoice(EP)).rejects.toThrow(/voice download failed/);
    expect(getMangaRecord(EP)?.voiceClips).toBe(1);
    server.set(`${V_URL}/001_0.mp3`, "MP3-B");
    await downloadMangaVoice(EP);
    expect(getMangaRecord(EP)?.voiceClips).toBe(2);
  });
});
