// Player: streams the staged 480p H.264 from the server (HTTP range = seek
// works) with the exact subtitle sidecar the analysis used, converted
// SRT→WebVTT in memory. Local video caching for true offline is a later pass
// (MOBILE.md decoupled pulls / WorkManager).

import { api } from "../api";

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r/g, "")
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n").filter(Boolean);
      if (!lines.length) return "";
      if (/^\d+$/.test(lines[0])) lines.shift(); // cue number
      if (lines[0]) lines[0] = lines[0].replace(/,/g, "."); // 00:00:01,000 → .
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

export function playerView(episodeId: string): HTMLElement {
  const root = el("div", "view player-view");
  const video = el("video") as HTMLVideoElement;
  video.controls = true;
  video.playsInline = true;
  video.src = api.videoUrl(episodeId);
  root.appendChild(video);

  const status = el("div", "status");
  root.appendChild(status);

  // subs sidecar → VTT track
  void api
    .fetchSubs(episodeId)
    .then((srt) => {
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = "日本語";
      track.srclang = "ja";
      track.default = true;
      track.src = URL.createObjectURL(new Blob([srtToVtt(srt)], { type: "text/vtt" }));
      video.appendChild(track);
    })
    .catch((e) => {
      status.textContent = `subs unavailable: ${(e as Error).message}`;
    });

  const prepLink = el("a", "btn", "open prep doc") as HTMLAnchorElement;
  prepLink.href = `#/prep/${encodeURIComponent(episodeId)}`;
  root.appendChild(prepLink);

  return root;
}
