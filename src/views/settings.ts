// Settings: server URL + token, connection test, outbox state + manual flush,
// prep cache management, and a demo-prep loader for developing without the
// server.

import { api, ApiError } from "../api";
import {
  cachedPrepIds,
  cachePrep,
  deleteCachedPrep,
  getCachedPrep,
  getOutbox,
  getSettings,
  outboxSummary,
  saveSettings,
} from "../store";
import { flushOutbox } from "../sync";
import { deleteVideo, downloadedEpisodes, fmtSize } from "../video";
import type { PrepDoc } from "../types";
import demoPrep from "../demo-prep.json";

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function field(labelText: string, input: HTMLInputElement): HTMLElement {
  const wrap = el("label", "field");
  wrap.appendChild(el("span", "field-label", labelText));
  wrap.appendChild(input);
  return wrap;
}

export function settingsView(): HTMLElement {
  const root = el("div", "view");
  const s = getSettings();

  root.appendChild(el("h2", "", "Server"));
  const url = el("input") as HTMLInputElement;
  url.type = "url";
  url.placeholder = "http://pc.tailnet-name.ts.net:8321";
  url.value = s.serverUrl;
  const token = el("input") as HTMLInputElement;
  token.type = "password";
  token.placeholder = "bearer token (optional)";
  token.value = s.token;
  root.append(field("Server URL (Tailscale MagicDNS)", url), field("Token", token));

  const save = el("button", "primary", "Save") as HTMLButtonElement;
  const test = el("button", "", "Test connection") as HTMLButtonElement;
  const connStatus = el("span", "muted");
  const row = el("div", "btnrow");
  row.append(save, test, connStatus);
  root.appendChild(row);

  save.addEventListener("click", () => {
    saveSettings({ serverUrl: url.value.trim(), token: token.value.trim() });
    connStatus.textContent = "saved ✔";
  });
  test.addEventListener("click", async () => {
    saveSettings({ serverUrl: url.value.trim(), token: token.value.trim() });
    connStatus.textContent = "…";
    try {
      await api.health();
    } catch (e) {
      connStatus.textContent = `✘ unreachable: ${(e as Error).message}`;
      return;
    }
    // /health is unauthenticated — prove the token separately so a typo
    // shows up here, not as a 401 later on the queue screen
    try {
      await api.listJobs();
      connStatus.textContent = "reachable ✔ · token OK ✔";
    } catch (e) {
      const err = e as ApiError;
      connStatus.textContent =
        err.status === 401
          ? "reachable ✔ but token rejected ✘ — recheck server.token in config.json"
          : `reachable ✔ but: ${err.message}`;
    }
  });

  root.appendChild(el("h2", "", "Outbox"));
  const outboxStatus = el("div", "status");
  const flush = el("button", "", "Flush now") as HTMLButtonElement;
  const renderOutbox = () => {
    const n = getOutbox().length;
    outboxStatus.textContent = n
      ? `${n} action${n > 1 ? "s" : ""} waiting to sync: ${outboxSummary()}`
      : "empty — everything synced";
    flush.disabled = !n;
  };
  flush.addEventListener("click", async () => {
    const res = await flushOutbox();
    renderOutbox();
    if (res.dropped)
      outboxStatus.textContent += ` (${res.dropped} stale action${res.dropped > 1 ? "s" : ""} dropped)`;
    if (res.error) outboxStatus.textContent += ` (⚠ ${res.error})`;
  });
  renderOutbox();
  root.append(outboxStatus, flush);

  root.appendChild(el("h2", "", "Cached prep docs"));
  const cacheList = el("div");
  const renderCache = () => {
    cacheList.textContent = "";
    const ids = cachedPrepIds();
    if (!ids.length) cacheList.appendChild(el("div", "muted", "none cached"));
    ids.forEach((id) => {
      const row = el("div", "job");
      const doc = getCachedPrep(id);
      row.appendChild(el("span", "job-title", doc?.episode.title || id));
      const del = el("button", "small", "delete") as HTMLButtonElement;
      del.addEventListener("click", () => {
        deleteCachedPrep(id);
        renderCache();
      });
      row.appendChild(del);
      cacheList.appendChild(row);
    });
  };
  renderCache();
  root.appendChild(cacheList);

  root.appendChild(el("h2", "", "Downloaded videos"));
  const videoList = el("div");
  const renderVideos = () => {
    videoList.textContent = "";
    const vids = downloadedEpisodes();
    if (!vids.length) {
      videoList.appendChild(el("div", "muted", "none on device"));
    } else {
      const total = vids.reduce((s, v) => s + v.rec.size, 0);
      videoList.appendChild(el("div", "muted", `${fmtSize(total)} used`));
      vids.forEach(({ ep, rec }) => {
        const row = el("div", "job");
        row.appendChild(el("span", "job-title", ep));
        row.appendChild(el("span", "muted", fmtSize(rec.size)));
        const del = el("button", "small", "delete") as HTMLButtonElement;
        del.addEventListener("click", async () => {
          await deleteVideo(ep);
          renderVideos();
        });
        row.appendChild(del);
        videoList.appendChild(row);
      });
    }
  };
  renderVideos();
  root.appendChild(videoList);

  root.appendChild(el("h2", "", "Developer"));
  const demo = el("button", "", "Load demo prep doc") as HTMLButtonElement;
  demo.addEventListener("click", () => {
    cachePrep(demoPrep as unknown as PrepDoc);
    renderCache();
    location.hash = `#/prep/${encodeURIComponent((demoPrep as { episode: { id: string } }).episode.id)}`;
  });
  root.appendChild(demo);

  return root;
}
