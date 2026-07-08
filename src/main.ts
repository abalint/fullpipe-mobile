// App shell: hash router + bottom nav. Four tabs (queue / listen / prep /
// settings); prep and player routes carry an episode id.

import "./style.css";
import { queueView } from "./views/queue";
import { passiveView } from "./views/passive";
import { prepView } from "./views/prep";
import { playerView } from "./views/player";
import { settingsView } from "./views/settings";
import { statsView } from "./views/stats";
import { installAutoFlush } from "./sync";
import { installShareTarget } from "./share";
import { cachedPrepIds, getSettings } from "./store";

const outlet = document.getElementById("outlet")!;

function route(): void {
  const hash = location.hash || "#/queue";
  // #/player/<id>/<seconds> deep-links a start position (prep-doc timestamps)
  const [, view, arg, arg2] = hash.split("/").map(decodeURIComponent);
  outlet.textContent = "";

  let node: HTMLElement;
  if (view === "prep" && arg) node = prepView(arg);
  else if (view === "player" && arg)
    node = playerView(arg, arg2 !== undefined && arg2 !== "" ? Number(arg2) : undefined);
  else if (view === "listen") node = passiveView();
  else if (view === "progress") node = statsView();
  else if (view === "settings") node = settingsView();
  else if (view === "prep") {
    // bare prep tab → most recently cached doc, else nudge to queue
    const ids = cachedPrepIds();
    node = ids.length ? prepView(ids[ids.length - 1]) : queueView();
  } else node = queueView();

  outlet.appendChild(node);

  document.querySelectorAll<HTMLAnchorElement>("nav a").forEach((a) => {
    a.classList.toggle("active", hash.startsWith(a.getAttribute("href")!.split("/", 2).join("/")));
  });
}

window.addEventListener("hashchange", route);

// first-run: no server configured → land on settings
if (!getSettings().serverUrl && !location.hash) location.hash = "#/settings";
route();
// after a background flush lands, rebuild the queue so pending-sync chips and
// stale snapshot states catch up with the server
installAutoFlush(() => {
  if (location.hash.startsWith("#/queue") || !location.hash) route();
});

// share-sheet → queue screen, which auto-enqueues the pending URL
installShareTarget((url) => {
  sessionStorage.setItem("fp.pendingShare", url);
  if (location.hash.startsWith("#/queue") || !location.hash) route();
  else location.hash = "#/queue";
});
