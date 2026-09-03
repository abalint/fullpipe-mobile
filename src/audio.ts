// Passive-listening playback: a thin wrapper over the native PassiveAudio
// plugin (foreground service + MediaSession), which is what keeps the audio
// running with the screen off and puts play/pause/next on the lock screen.
// The playlist is built from already-downloaded episode mp4s — the audio
// track plays straight from the same file the rewatch option uses.

import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { getPosition, getVideoRecord } from "./video";
import type { Job, ViewKind, ViewSegment } from "./types";

export interface PassiveTrack {
  src: string; // file:// URI of the downloaded mp4
  title: string;
  episodeId: string;
  startMs?: number; // resume hint (video player's saved position); the
  // service's own persisted position wins over it, and it only applies to the
  // episode you actually started on, once — looping relistens start at the top
}

/** Mirror of the service's state broadcast — also the getState() shape.
    While playing, the service ticks this out every second. */
export interface PassiveAudioState {
  running: boolean; // service alive with a playlist loaded
  playing: boolean;
  index: number;
  episodeId?: string;
  speed?: number;
  positionMs?: number; // current track position — hands back to the video player
  durationMs?: number; // current track duration (0 until prepared)
  sleepRemainingMs?: number; // sleep timer countdown; 0 = no timer armed
}

interface PassiveAudioPlugin {
  play(opts: {
    items: PassiveTrack[];
    startIndex?: number;
    speed?: number;
    startPositionMs?: number; // resume the track here (video-player handoff)
    // how the service logs this playback's time (viewtime.ts): the Listen
    // tab's queue is passive "listen" (default); the player's audio-only
    // mode is still the episode being actively followed → "watch"
    kind?: ViewKind;
  }): Promise<void>;
  toggle(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  stop(): Promise<void>;
  setSpeed(opts: { speed: number }): Promise<void>;
  seekTo(opts: { positionMs: number }): Promise<void>;
  seekBy(opts: { deltaMs: number }): Promise<void>;
  setSleepTimer(opts: { minutes: number }): Promise<void>; // 0 cancels
  setSavedPosition(opts: { episodeId: string; positionMs: number }): Promise<void>; // ≤0 clears
  getLastEpisode(): Promise<{ episodeId?: string }>; // queue memory; works with the service dead
  // the service's own listening-time log (it runs with the webview dead, so
  // it keeps the minutes itself): closed segments awaiting import, and the
  // ack that clears them once viewtime.ts has stored them
  getListenLog(): Promise<{ entries: ViewSegment[]; open?: ViewSegment }>;
  clearListenLog(opts: { ids: string[] }): Promise<void>;
  getState(): Promise<PassiveAudioState>;
  addListener(
    eventName: "state",
    fn: (state: PassiveAudioState) => void,
  ): Promise<PluginListenerHandle>;
}

export const PassiveAudio = registerPlugin<PassiveAudioPlugin>("PassiveAudio");

/** Where playback should begin: an explicitly tapped episode wins, else the
    remembered last-played episode (the queue's memory), else the top. An
    episode that's gone from the list (deleted, unshelved) falls to the top. */
export function resolveStartIndex(
  items: PassiveTrack[],
  fromEp?: string,
  lastEp?: string,
): number {
  const want = fromEp ?? lastEp;
  const i = want ? items.findIndex((t) => t.episodeId === want) : -1;
  return i >= 0 ? i : 0;
}

/** Playlist from the passive jobs that have a local download, list order
    preserved. Episodes without a download are skipped (the view flags them). */
export async function buildPlaylist(jobs: Job[]): Promise<PassiveTrack[]> {
  const items: PassiveTrack[] = [];
  for (const j of jobs) {
    const rec = getVideoRecord(j.episode_id);
    if (!rec) continue;
    const { uri } = await Filesystem.getUri({ path: rec.path, directory: Directory.Data });
    const pos = getPosition(j.episode_id);
    items.push({
      src: uri,
      title: j.title || j.source || j.episode_id,
      episodeId: j.episode_id,
      startMs: pos != null ? Math.floor(pos * 1000) : 0,
    });
  }
  return items;
}
