// Browser fallback for the Ambience plugin (vite dev in Chrome, tests): the
// same surface over HTMLAudio elements. Loops here are <audio loop>, which
// is not gapless in every browser — good enough to work on the panel
// without a phone. The native service is the real player.

import { WebPlugin } from "@capacitor/core";
import type { AmbiencePlugin, AmbienceState } from "./ambience";

const gain = (v: number) => Math.max(0, Math.min(1, v)) ** 2;

export class AmbienceWeb extends WebPlugin implements AmbiencePlugin {
  private layers = new Map<string, { a: HTMLAudioElement; volume: number; title: string }>();
  private tracks: { src: string; title: string }[] = [];
  private order: number[] = [];
  private pos = -1;
  private music: HTMLAudioElement | null = null;
  private moodTitle = "";
  private musicVol = 0.6;
  private paused = false;
  private ducked = false;

  private emit(): void {
    this.notifyListeners("state", this.snapshot());
  }

  private snapshot(): AmbienceState {
    const s: AmbienceState = {
      running: this.layers.size > 0 || this.tracks.length > 0,
      paused: this.paused,
      layers: [...this.layers].map(([id, l]) => ({ id, volume: l.volume })),
    };
    if (this.tracks.length && this.pos >= 0) {
      const t = this.tracks[this.order[this.pos]];
      s.music = { mood: this.moodTitle, title: t.title, src: t.src, count: this.tracks.length, volume: this.musicVol };
    }
    return s;
  }

  async setLayer(o: { id: string; src: string; title: string; volume: number }): Promise<void> {
    const cur = this.layers.get(o.id);
    if (cur && cur.a.src === o.src) {
      cur.volume = o.volume;
      cur.a.volume = gain(o.volume);
    } else {
      cur?.a.pause();
      const a = new Audio(o.src);
      a.loop = true;
      a.volume = gain(o.volume);
      if (!this.paused) void a.play().catch(() => {});
      this.layers.set(o.id, { a, volume: o.volume, title: o.title });
    }
    this.emit();
  }

  async removeLayer(o: { id: string }): Promise<void> {
    this.layers.get(o.id)?.a.pause();
    this.layers.delete(o.id);
    this.emit();
  }

  async setLayerVolume(o: { id: string; volume: number }): Promise<void> {
    const l = this.layers.get(o.id);
    if (l) {
      l.volume = o.volume;
      l.a.volume = gain(o.volume);
    }
    this.emit();
  }

  async setMusic(o: { tracks: { src: string; title: string }[]; title: string; volume: number; keep?: boolean }): Promise<void> {
    const playing = o.keep && this.pos >= 0 ? this.tracks[this.order[this.pos]]?.src : undefined;
    this.tracks = o.tracks;
    this.moodTitle = o.title;
    this.musicVol = o.volume;
    this.order = this.tracks.map((_, i) => i).sort(() => Math.random() - 0.5);
    const at = playing ? this.tracks.findIndex((t) => t.src === playing) : -1;
    if (at >= 0) {
      this.order = [at, ...this.order.filter((i) => i !== at)];
      this.pos = 0;
      this.applyMusicVolume();
    } else {
      this.playPos(0);
    }
    this.emit();
  }

  private playPos(p: number): void {
    this.music?.pause();
    this.music = null;
    if (!this.tracks.length) return;
    this.pos = ((p % this.order.length) + this.order.length) % this.order.length;
    const a = new Audio(this.tracks[this.order[this.pos]].src);
    a.addEventListener("ended", () => this.playPos(this.pos + 1));
    this.music = a;
    this.applyMusicVolume();
    if (!this.paused) void a.play().catch(() => {});
    this.emit();
  }

  private applyMusicVolume(): void {
    if (this.music) this.music.volume = gain(this.musicVol) * (this.ducked ? 0.25 : 1);
  }

  async stopMusic(): Promise<void> {
    this.music?.pause();
    this.music = null;
    this.tracks = [];
    this.pos = -1;
    this.moodTitle = "";
    this.emit();
  }

  async nextTrack(): Promise<void> {
    if (this.tracks.length) this.playPos(this.pos + 1);
  }

  async previousTrack(): Promise<void> {
    if (this.tracks.length) this.playPos(this.pos - 1);
  }

  async setMusicVolume(o: { volume: number }): Promise<void> {
    this.musicVol = o.volume;
    this.applyMusicVolume();
    this.emit();
  }

  async pause(): Promise<void> {
    this.paused = true;
    for (const l of this.layers.values()) l.a.pause();
    this.music?.pause();
    this.emit();
  }

  async resume(): Promise<void> {
    this.paused = false;
    for (const l of this.layers.values()) void l.a.play().catch(() => {});
    void this.music?.play().catch(() => {});
    this.emit();
  }

  async stopAll(): Promise<void> {
    for (const l of this.layers.values()) l.a.pause();
    this.layers.clear();
    await this.stopMusic();
    this.paused = false;
    this.emit();
  }

  async setDuck(o: { on: boolean }): Promise<void> {
    this.ducked = o.on;
    this.applyMusicVolume();
  }

  async getState(): Promise<AmbienceState> {
    return this.snapshot();
  }
}
