// Passive-listening playback: a thin wrapper over the native PassiveAudio
// plugin (foreground service + MediaSession), which is what keeps the audio
// running with the screen off and puts play/pause/next on the lock screen.
// The playlist is built from already-downloaded episode mp4s — the audio
// track plays straight from the same file the rewatch option uses.

import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { getVideoRecord } from "./video";
import type { Job } from "./types";

export interface PassiveTrack {
  src: string; // file:// URI of the downloaded mp4
  title: string;
  episodeId: string;
}

/** Mirror of the service's state broadcast — also the getState() shape. */
export interface PassiveAudioState {
  running: boolean; // service alive with a playlist loaded
  playing: boolean;
  index: number;
  episodeId?: string;
  speed?: number;
  positionMs?: number; // current track position — hands back to the video player
}

interface PassiveAudioPlugin {
  play(opts: {
    items: PassiveTrack[];
    startIndex?: number;
    speed?: number;
    startPositionMs?: number; // resume the track here (video-player handoff)
  }): Promise<void>;
  toggle(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  stop(): Promise<void>;
  setSpeed(opts: { speed: number }): Promise<void>;
  getState(): Promise<PassiveAudioState>;
  addListener(
    eventName: "state",
    fn: (state: PassiveAudioState) => void,
  ): Promise<PluginListenerHandle>;
}

export const PassiveAudio = registerPlugin<PassiveAudioPlugin>("PassiveAudio");

/** Playlist from the passive jobs that have a local download, list order
    preserved. Episodes without a download are skipped (the view flags them). */
export async function buildPlaylist(jobs: Job[]): Promise<PassiveTrack[]> {
  const items: PassiveTrack[] = [];
  for (const j of jobs) {
    const rec = getVideoRecord(j.episode_id);
    if (!rec) continue;
    const { uri } = await Filesystem.getUri({ path: rec.path, directory: Directory.Data });
    items.push({ src: uri, title: j.title || j.source || j.episode_id, episodeId: j.episode_id });
  }
  return items;
}
