// Ambience: background sound for reading — looping sounds (rain, waves,
// noise…) layered at their own volumes, plus one music channel playing a
// mood's tracks on shuffle. The library is built on the PC (tools/ambience.py)
// and served as a catalog; the phone pulls a sound or a mood the first time
// it's switched on and plays it from local files through the native
// AmbienceService (foreground, so it survives the screen going off and
// coexists with the Listen tab and the reader's voice clips — it never takes
// audio focus). The mix you last had on is remembered, so the next reading
// session is one tap.

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { api, ApiError } from "./api";
import { getSettings } from "./store";

// ---- catalog (GET /ambience) ---------------------------------------------------

export interface AmbienceSound {
  id: string;
  title: string;
  emoji: string;
  file: string; // relative: sounds/<id>.ogg
  ms: number;
  bytes: number;
}

export interface AmbienceTrack {
  id: string; // YouTube video id
  title: string;
  channel?: string | null;
  file: string; // relative: music/<mood>/<id>.ogg
  ms: number;
  bytes: number;
}

export interface AmbienceMood {
  id: string;
  title: string;
  emoji: string;
  tracks: AmbienceTrack[];
}

export interface AmbienceCatalog {
  built_at: string | null;
  sounds: AmbienceSound[];
  moods: AmbienceMood[];
  bytes?: number;
}

// ---- native plugin ---------------------------------------------------------------

export interface AmbienceState {
  running: boolean;
  paused: boolean;
  layers: { id: string; volume: number }[];
  music?: { mood: string; title: string; src: string; count: number; volume: number };
}

export interface AmbiencePlugin {
  setLayer(opts: { id: string; src: string; title: string; volume: number }): Promise<void>;
  removeLayer(opts: { id: string }): Promise<void>;
  setLayerVolume(opts: { id: string; volume: number }): Promise<void>;
  setMusic(opts: {
    tracks: { src: string; title: string }[];
    title: string;
    volume: number;
    keep?: boolean; // keep the current track if it's still in the list
  }): Promise<void>;
  stopMusic(): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  setMusicVolume(opts: { volume: number }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stopAll(): Promise<void>;
  setDuck(opts: { on: boolean }): Promise<void>; // music to a murmur while a voice clip speaks
  getState(): Promise<AmbienceState>;
  addListener(eventName: "state", fn: (s: AmbienceState) => void): Promise<PluginListenerHandle>;
}

export const Ambience = registerPlugin<AmbiencePlugin>("Ambience", {
  web: () => import("./ambience-web").then((m) => new m.AmbienceWeb()),
});

// ---- the remembered mix -----------------------------------------------------------

export interface Mix {
  /** sound id → slider volume (0–1) of the layers that are on */
  layers: Record<string, number>;
  mood: string | null;
  musicVolume: number;
}

const MIX_KEY = "fp.ambience.mix";
const CATALOG_KEY = "fp.ambience.catalog";
const LOCAL_KEY = "fp.ambience.local"; // relative file → bytes, files on disk
const ROOT = "ambience"; // under Directory.Data

export const DEFAULT_LAYER_VOLUME = 0.55;
export const DEFAULT_MUSIC_VOLUME = 0.5;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function getMix(): Mix {
  const m = readJson<Partial<Mix>>(MIX_KEY, {});
  return {
    layers: m.layers ?? {},
    mood: m.mood ?? null,
    musicVolume: m.musicVolume ?? DEFAULT_MUSIC_VOLUME,
  };
}

export function saveMix(m: Mix): void {
  localStorage.setItem(MIX_KEY, JSON.stringify(m));
}

export function mixIsEmpty(m: Mix): boolean {
  return !m.mood && Object.keys(m.layers).length === 0;
}

/** "🌧 Rain · 🔥 Fire · 🎧 Focus" — what the mix would sound like. */
export function describeMix(m: Mix, cat: AmbienceCatalog | null): string {
  const parts: string[] = [];
  for (const id of Object.keys(m.layers)) {
    const s = cat?.sounds.find((x) => x.id === id);
    parts.push(s ? `${s.emoji} ${s.title}` : id);
  }
  if (m.mood) {
    const mood = cat?.moods.find((x) => x.id === m.mood);
    parts.push(mood ? `${mood.emoji} ${mood.title}` : m.mood);
  }
  return parts.join(" · ");
}

// ---- catalog cache ------------------------------------------------------------------

export function getCatalog(): AmbienceCatalog | null {
  return readJson<AmbienceCatalog | null>(CATALOG_KEY, null);
}

/** Pull the catalog; offline, the cached one stands. Returns null only when
    there is neither. */
export async function refreshCatalog(): Promise<AmbienceCatalog | null> {
  try {
    const cat = await api.getAmbience();
    localStorage.setItem(CATALOG_KEY, JSON.stringify(cat));
    return cat;
  } catch (e) {
    if (e instanceof ApiError && e.status && e.status !== 404) throw e;
    return getCatalog();
  }
}

// ---- local files ---------------------------------------------------------------------

function localIndex(): Record<string, number> {
  return readJson<Record<string, number>>(LOCAL_KEY, {});
}

function markLocal(file: string, bytes: number | null): void {
  const idx = localIndex();
  if (bytes == null) delete idx[file];
  else idx[file] = bytes;
  localStorage.setItem(LOCAL_KEY, JSON.stringify(idx));
}

export function isLocal(file: string): boolean {
  return file in localIndex();
}

export function localBytes(): number {
  return Object.values(localIndex()).reduce((a, b) => a + b, 0);
}

/** Whether a mood is fully on the phone; `some` = at least one track. */
export function moodLocal(mood: AmbienceMood): { all: boolean; some: boolean; done: number } {
  const done = mood.tracks.filter((t) => isLocal(t.file)).length;
  return { all: done === mood.tracks.length && mood.tracks.length > 0, some: done > 0, done };
}

async function statBytes(path: string): Promise<number | null> {
  try {
    const st = await Filesystem.stat({ path, directory: Directory.Data });
    return Number(st.size) || 0;
  } catch {
    return null;
  }
}

/** Re-check the index against the disk (a cleared app, a failed download
    that left no file) — cheap, a stat per file. */
export async function verifyLocal(): Promise<void> {
  for (const file of Object.keys(localIndex())) {
    if ((await statBytes(`${ROOT}/${file}`)) == null) markLocal(file, null);
  }
}

async function fileSrc(file: string): Promise<string> {
  const { uri } = await Filesystem.getUri({ path: `${ROOT}/${file}`, directory: Directory.Data });
  return uri; // file:// — the native player opens the path directly
}

/** Download one catalog file into the ambience folder (idempotent: a file
    already on disk with the catalog's size is kept). */
export async function ensureFile(entry: { file: string; bytes: number }): Promise<void> {
  const path = `${ROOT}/${entry.file}`;
  const have = await statBytes(path);
  if (have != null && (have === entry.bytes || entry.bytes === 0)) {
    markLocal(entry.file, have);
    return;
  }
  // downloadFile's `recursive` doesn't create the parent folder on Android
  // (ENOENT on the first file of a new folder) — make it first, like manga.ts
  // (stat before mkdir: a mkdir on an existing folder rejects, and the
  // bridge logs every rejection as a console error)
  const dir = path.slice(0, path.lastIndexOf("/"));
  if ((await statBytes(dir)) == null) {
    try {
      await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
    } catch {
      /* raced into existence */
    }
  }
  const { token } = getSettings();
  await Filesystem.downloadFile({
    url: api.ambienceFileUrl(entry.file),
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    path,
    directory: Directory.Data,
    recursive: true,
  });
  const got = (await statBytes(path)) ?? entry.bytes;
  markLocal(entry.file, got);
}

export async function deleteLocal(file: string): Promise<void> {
  try {
    await Filesystem.deleteFile({ path: `${ROOT}/${file}`, directory: Directory.Data });
  } catch {
    /* gone already */
  }
  markLocal(file, null);
}

/** Drop every downloaded ambience file (Settings → storage). */
export async function deleteAllLocal(): Promise<void> {
  try {
    await Filesystem.rmdir({ path: ROOT, directory: Directory.Data, recursive: true });
  } catch {
    /* nothing there */
  }
  localStorage.removeItem(LOCAL_KEY);
}

// ---- control ---------------------------------------------------------------------------
// Every control both drives the native service and updates the remembered
// mix, so "what's on" and "what to resume" are one thing.

export async function layerOn(sound: AmbienceSound, volume?: number): Promise<void> {
  const mix = getMix();
  const v = volume ?? mix.layers[sound.id] ?? DEFAULT_LAYER_VOLUME;
  await ensureFile(sound);
  await Ambience.setLayer({ id: sound.id, src: await fileSrc(sound.file), title: `${sound.emoji} ${sound.title}`, volume: v });
  mix.layers[sound.id] = v;
  saveMix(mix);
}

export async function layerOff(id: string): Promise<void> {
  const mix = getMix();
  delete mix.layers[id];
  saveMix(mix);
  await Ambience.removeLayer({ id });
}

export async function layerVolume(id: string, volume: number): Promise<void> {
  const mix = getMix();
  if (id in mix.layers) {
    mix.layers[id] = volume;
    saveMix(mix);
  }
  await Ambience.setLayerVolume({ id, volume });
}

/** Switch the music channel to a mood. Tracks not on the phone download
    in the background, in catalog order; playback starts as soon as one is
    local and the queue grows as the rest land (the service keeps the
    playing track). `onProgress(done, total)` narrates the pull. */
export async function moodOn(
  mood: AmbienceMood,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const mix = getMix();
  mix.mood = mood.id;
  saveMix(mix);
  const title = `${mood.emoji} ${mood.title}`;
  const push = async () => {
    const local = mood.tracks.filter((t) => isLocal(t.file));
    if (!local.length) return;
    const tracks = await Promise.all(
      local.map(async (t) => ({ src: await fileSrc(t.file), title: t.title })),
    );
    // the mood may have been switched away while a track was downloading
    if (getMix().mood !== mood.id) return;
    await Ambience.setMusic({ tracks, title, volume: mix.musicVolume, keep: true });
  };
  let done = mood.tracks.filter((t) => isLocal(t.file)).length;
  onProgress?.(done, mood.tracks.length);
  await push();
  for (const t of mood.tracks) {
    if (getMix().mood !== mood.id) return; // switched away: stop pulling
    if (isLocal(t.file)) continue;
    await ensureFile(t);
    done++;
    onProgress?.(done, mood.tracks.length);
    await push();
  }
}

export async function moodOff(): Promise<void> {
  const mix = getMix();
  mix.mood = null;
  saveMix(mix);
  await Ambience.stopMusic();
}

export async function musicVolume(volume: number): Promise<void> {
  const mix = getMix();
  mix.musicVolume = volume;
  saveMix(mix);
  await Ambience.setMusicVolume({ volume });
}

/** Start everything the remembered mix names (the one-tap resume). */
export async function resumeMix(
  cat: AmbienceCatalog,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const mix = getMix();
  for (const [id, v] of Object.entries(mix.layers)) {
    const s = cat.sounds.find((x) => x.id === id);
    if (s) await layerOn(s, v);
    else await layerOff(id);
  }
  if (mix.mood) {
    const mood = cat.moods.find((m) => m.id === mix.mood);
    if (mood) await moodOn(mood, onProgress);
    else await moodOff();
  }
}

/** Stop the sound but keep the mix remembered for next time. */
export async function stopAll(): Promise<void> {
  await Ambience.stopAll();
}

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}
