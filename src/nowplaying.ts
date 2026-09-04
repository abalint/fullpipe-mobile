// Now-playing strip: while the native passive-audio service is running (the
// Listen tab's queue, or the player's 🎧 audio mode), a one-line bar above
// the bottom nav names the episode coming out of the speaker and takes you
// straight to it — tap the title to open its video in the player (which
// picks the running audio session back up rather than restarting it), or
// ⏯ to pause/resume without leaving the current tab. It hides on the views
// that already show that episode: its own player, and the Listen tab.

import { PassiveAudio } from "./audio";
import type { PassiveAudioState } from "./audio";
import { fmtClock } from "./views/player";

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Whether the strip should show for this playback state on this route. */
export function nowPlayingVisible(state: PassiveAudioState, hash: string): boolean {
  if (!state.running || !state.episodeId) return false;
  const [, view, arg] = hash.split("/").map(decodeURIComponent);
  if (view === "listen") return false;
  if (view === "player" && arg === state.episodeId) return false;
  return true;
}

/** Build the strip and keep it in step with the service + the router.
    Mounted once by main.ts before the nav; `titleOf` resolves an episode id
    to its title from the cached queue. */
export function nowPlayingStrip(titleOf: (episodeId: string) => string | undefined): HTMLElement {
  const bar = el("div", "nowplaying");
  bar.hidden = true;
  const go = el("a", "np-go") as HTMLAnchorElement;
  const tag = el("b", "", "🎧");
  const title = el("span", "np-title");
  const pos = el("span", "np-pos");
  go.append(tag, title, pos);
  const toggle = el("button", "small", "⏸") as HTMLButtonElement;
  toggle.addEventListener("click", () => void PassiveAudio.toggle().catch(() => {}));
  bar.append(go, toggle);

  let state: PassiveAudioState = { running: false, playing: false, index: -1 };

  const paint = () => {
    const show = nowPlayingVisible(state, location.hash);
    bar.hidden = !show;
    // the fixed gloss card offsets itself by this so it never sits on the strip
    document.documentElement.style.setProperty("--nowplaying-h", show ? `${bar.offsetHeight || 40}px` : "0px");
    if (!show) return;
    const ep = state.episodeId!;
    go.href = `#/player/${encodeURIComponent(ep)}`;
    title.textContent = titleOf(ep) || ep;
    pos.textContent =
      state.positionMs != null && state.durationMs
        ? `${fmtClock(state.positionMs / 1000)} / ${fmtClock(state.durationMs / 1000)}`
        : "";
    toggle.textContent = state.playing ? "⏸" : "▶";
  };

  void PassiveAudio.addListener("state", (s) => {
    state = s;
    paint();
  }).catch(() => {});
  void PassiveAudio.getState()
    .then((s) => {
      state = s;
      paint();
    })
    .catch(() => {});
  window.addEventListener("hashchange", paint);
  return bar;
}
