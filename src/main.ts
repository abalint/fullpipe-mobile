// App shell: hash router + bottom nav. Three tabs (queue / prep / settings);
// prep and player routes carry an episode id.

import "./style.css";
import { queueView } from "./views/queue";
import { prepView } from "./views/prep";
import { playerView } from "./views/player";
import { settingsView } from "./views/settings";
import { installAutoFlush } from "./sync";
import { installShareTarget } from "./share";
import { cachedPrepIds, getSettings } from "./store";

const outlet = document.getElementById("outlet")!;

function route(): void {
  const hash = location.hash || "#/queue";
  const [, view, arg] = hash.split("/").map(decodeURIComponent);
  outlet.textContent = "";

  let node: HTMLElement;
  if (view === "prep" && arg) node = prepView(arg);
  else if (view === "player" && arg) node = playerView(arg);
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
installAutoFlush();

// share-sheet → queue screen, which auto-enqueues the pending URL
installShareTarget((url) => {
  sessionStorage.setItem("fp.pendingShare", url);
  if (location.hash.startsWith("#/queue") || !location.hash) route();
  else location.hash = "#/queue";
});
