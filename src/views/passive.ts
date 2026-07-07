// Listen screen: the passive-listening collection. Watched episodes shelved
// here play like an mp3 playlist — native background audio (screen off, lock
// screen controls) via the PassiveAudio plugin, looping the whole list.
// Every row keeps a "watch" escape hatch back into the full in-app player,
// and swipe-to-delete is the exact same delete the queue rows use.

import { api } from "../api";
import { buildPlaylist, PassiveAudio } from "../audio";
import type { PassiveAudioState } from "../audio";
import { cacheJobs, getCachedJobs } from "../store";
import { downloadVideo, getVideoRecord } from "../video";
import { fmtDur, isPassive, removeJob, sortJobs, swipeable } from "./queue";
import type { Job } from "../types";

const SPEED_KEY = "fp.listen.speed";
const SPEEDS = [0.8, 1, 1.2, 1.5];

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function savedSpeed(): number {
  const n = Number(localStorage.getItem(SPEED_KEY));
  return SPEEDS.includes(n) ? n : 1;
}

export function passiveView(): HTMLElement {
  const root = el("div", "view");
  const status = el("div", "status");
  const list = el("div", "joblist");

  let jobs: Job[] = [];
  let offline = false;
  let player: PassiveAudioState = { running: false, playing: false, index: -1 };

  const passiveJobs = () => sortJobs(jobs.filter(isPassive), "newest");

  // --- now-playing bar -------------------------------------------------------
  const bar = el("div", "listenbar");
  const barTitle = el("div", "listenbar-title");
  const controls = el("div", "listenbar-controls");
  const btn = (label: string, fn: () => Promise<unknown>): HTMLButtonElement => {
    const b = el("button", "small", label) as HTMLButtonElement;
    b.addEventListener("click", () => void fn().catch((e) => alert((e as Error).message)));
    controls.appendChild(b);
    return b;
  };
  btn("⏮", () => PassiveAudio.previous());
  const playPause = btn("⏸", () => PassiveAudio.toggle());
  btn("⏭", () => PassiveAudio.next());
  btn("⏹", () => PassiveAudio.stop());
  const speedSel = el("select", "small") as HTMLSelectElement;
  for (const s of SPEEDS) {
    const o = el("option", "", `${s}×`) as HTMLOptionElement;
    o.value = String(s);
    speedSel.appendChild(o);
  }
  speedSel.value = String(savedSpeed());
  speedSel.addEventListener("change", () => {
    localStorage.setItem(SPEED_KEY, speedSel.value);
    if (player.running)
      void PassiveAudio.setSpeed({ speed: Number(speedSel.value) }).catch(() => {});
  });
  controls.appendChild(speedSel);
  bar.append(barTitle, controls);

  function renderBar(): void {
    bar.style.display = player.running ? "" : "none";
    if (!player.running) return;
    const cur = jobs.find((j) => j.episode_id === player.episodeId);
    barTitle.textContent = cur?.title || player.episodeId || "";
    playPause.textContent = player.playing ? "⏸" : "▶";
  }

  /** Start background playback over every downloaded passive episode,
      beginning at `fromEp` (default: the top of the list). */
  async function play(fromEp?: string): Promise<void> {
    const items = await buildPlaylist(passiveJobs());
    if (!items.length) {
      alert("Nothing downloaded to play — tap ⬇ on an episode first.");
      return;
    }
    const start = fromEp ? items.findIndex((t) => t.episodeId === fromEp) : 0;
    await PassiveAudio.play({
      items,
      startIndex: Math.max(0, start),
      speed: savedSpeed(),
    });
  }

  // --- rows --------------------------------------------------------------------
  function jobRow(job: Job): HTMLElement {
    const row = el("div", "job");
    if (player.running && player.episodeId === job.episode_id) row.classList.add("playing");
    const main = el("div", "job-main");
    main.appendChild(el("div", "job-title", job.title || job.source || job.episode_id));
    const sub = el("div", "job-sub");
    sub.appendChild(el("span", "chip st-watched", "passive"));
    if (job.duration) sub.appendChild(el("span", "muted", ` ${fmtDur(job.duration)}`));
    if (!getVideoRecord(job.episode_id))
      sub.appendChild(el("span", "muted", " · not downloaded"));
    main.appendChild(sub);
    row.appendChild(main);

    const actions = el("div", "job-actions");
    if (getVideoRecord(job.episode_id)) {
      const listen = el("button", "small", "▶ listen") as HTMLButtonElement;
      listen.addEventListener("click", () =>
        void play(job.episode_id).catch((e) => alert((e as Error).message)),
      );
      actions.appendChild(listen);
      // the rewatch escape hatch — same in-app player as the queue
      const watch = el("a", "small btn", "watch") as HTMLAnchorElement;
      watch.href = `#/player/${encodeURIComponent(job.episode_id)}`;
      actions.appendChild(watch);
    } else if (!offline) {
      const dl = el("button", "small", "⬇") as HTMLButtonElement;
      dl.addEventListener("click", async () => {
        dl.disabled = true;
        try {
          await downloadVideo(job.episode_id, (frac, bytes) => {
            dl.textContent = frac != null
              ? `⬇ ${Math.round(frac * 100)}%`
              : `⬇ ${Math.round(bytes / 1e6)} MB`;
          });
          render();
        } catch (e) {
          dl.textContent = "⬇";
          dl.disabled = false;
          alert(`download failed: ${(e as Error).message}`);
        }
      });
      actions.appendChild(dl);
    }
    if (!offline) {
      const unshelve = el("button", "small", "↩ queue") as HTMLButtonElement;
      unshelve.addEventListener("click", async () => {
        unshelve.disabled = true;
        try {
          await api.setPassive(job.episode_id, false);
        } catch (e) {
          alert((e as Error).message);
        }
        void load();
      });
      actions.appendChild(unshelve);
    }
    row.appendChild(actions);
    return row;
  }

  function render(): void {
    const rows = passiveJobs();
    if (!offline)
      status.textContent = rows.length
        ? ""
        : "nothing here yet — 🎧 a watched episode on the Queue tab";
    list.textContent = "";
    for (const j of rows)
      list.appendChild(swipeable(jobRow(j), () => void removeJob(j, () => void load(), offline)));
    renderBar();
  }

  async function load(): Promise<void> {
    try {
      jobs = await api.listJobs();
      offline = false;
      cacheJobs(jobs);
    } catch {
      // offline: the cached snapshot still knows what's passive, and
      // downloaded episodes play fine without the server
      offline = true;
      const snap = getCachedJobs();
      jobs = snap?.jobs ?? [];
      status.textContent = snap
        ? `⚠ offline — cached list from ${new Date(snap.at).toLocaleString()}`
        : "⚠ offline — no cached list";
    }
    render();
  }

  // --- toolbar -----------------------------------------------------------------
  const toolbar = el("div", "toolbar");
  const playAll = el("button", "small", "▶ play all") as HTMLButtonElement;
  playAll.addEventListener("click", () =>
    void play().catch((e) => alert((e as Error).message)),
  );
  const refresh = el("button", "small refresh", "↻ refresh") as HTMLButtonElement;
  refresh.addEventListener("click", () => void load());
  toolbar.append(playAll, refresh);

  root.append(toolbar, bar, status, list);

  // live state from the service → highlight + bar; self-detaches when the
  // router swaps this view out
  const listener = PassiveAudio.addListener("state", (s) => {
    if (!root.isConnected) {
      void listener.then((h) => h.remove());
      return;
    }
    player = s;
    render();
  });
  void PassiveAudio.getState()
    .then((s) => {
      player = s;
      renderBar();
    })
    .catch(() => {});

  void load();
  return root;
}
