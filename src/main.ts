// App shell: hash router + bottom nav. Tabs: queue / listen / pages /
// progress / prep / settings; prep, player and page routes carry an episode id.

import "./style.css";
import { queueView } from "./views/queue";
import { passiveView } from "./views/passive";
import { pagesView } from "./views/pages";
import { readerView } from "./views/reader";
import { prepView } from "./views/prep";
import { playerView } from "./views/player";
import { settingsView } from "./views/settings";
import { statsView } from "./views/stats";
import { confirmView } from "./views/confirm";
import { flushOutbox, installAutoFlush } from "./sync";
import { importListenLog, recoverOpenSegment } from "./viewtime";
import { installShareTarget } from "./share";
import { isPageSource } from "./pages";
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
  else if (view === "page" && arg) node = readerView(arg);
  else if (view === "pages") node = pagesView();
  else if (view === "listen") node = passiveView();
  else if (view === "progress") node = statsView();
  else if (view === "confirm") node = confirmView();
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

// immersion time: keep a segment the last process death left open, and pull
// whatever the background listener logged while the webview was gone —
// here and on every return to the foreground
recoverOpenSegment();
const pullListenLog = () =>
  importListenLog().then(({ added }) => {
    if (!added) return;
    void flushOutbox();
    if (location.hash.startsWith("#/progress")) route();
  });
void pullListenLog();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void pullListenLog();
});

// first-run: no server configured → land on settings
if (!getSettings().serverUrl && !location.hash) location.hash = "#/settings";
route();
// after a background flush lands, rebuild the queue so pending-sync chips and
// stale snapshot states catch up with the server
installAutoFlush(() => {
  if (location.hash.startsWith("#/queue") || !location.hash) route();
});

// share-sheet → queue screen (or Pages for a 5ch thread URL), which
// auto-enqueues the pending URL
installShareTarget((url) => {
  sessionStorage.setItem("fp.pendingShare", url);
  const dest = isPageSource(url) ? "#/pages" : "#/queue";
  if (location.hash.startsWith(dest) || (!location.hash && dest === "#/queue")) route();
  else location.hash = dest;
});
