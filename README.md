# fullPipe mobile — Android client

The phone side of `fullPipe/MOBILE.md`: queue screen · prep-doc viewer with
know/don't-know taps · tap outbox with idempotent sync · in-app learning
player (tokenized tap-able subs, replay-line, speed) · 1–5★ rating +
taste-tag picker · Android share-sheet enqueue target. Capacitor (web UI wrapped
native); the prep viewer is a TS port of `fullPipe/render/template.html`, so
the in-app doc looks and behaves like the static one.

Talks to the fullPipe sync server (`fullPipe/server/`) over Tailscale. Point Settings → Server URL at the PC's MagicDNS name
(`http://<pc>.<tailnet>.ts.net:<port>`). Cleartext HTTP is only permitted for
`*.ts.net` / localhost (`android/app/src/main/res/xml/network_security_config.xml`),
so use the hostname, not a raw `100.x` IP.

## Layout

```
src/
├── main.ts            app shell: hash router + bottom nav (Queue / Listen / Progress / Prep / Settings)
├── api.ts             client for the MOBILE.md server API
├── store.ts           settings · per-episode taps · outbox · prep-doc + stats cache (localStorage)
├── sync.ts            opportunistic outbox flush (start / online / visible)
├── viewtime.ts        immersion-time recorder (watch vs listen) + week/day grouping
├── listfilter.ts      sort + status/genre/on-phone filters shared by the Queue and Listen tabs
├── nowplaying.ts      now-playing strip above the nav → back to the episode the audio service is playing
├── paint.ts           live highlight state (GET /paint) overlaid on cached sidecars
├── prep-render.ts     prep-doc renderer (port of render/template.html)
├── share.ts           JS side of the share-sheet target
├── views/             queue · prep · player · stats · settings
├── demo-prep.json     fixture (from render/demo-prep.html) — Settings → "Load demo prep doc"
└── smoke.test.ts      DOM smoke tests (vitest + happy-dom)
```

Native additions under `android/`: `ShareTargetPlugin.java` (+ `MainActivity`
registration, SEND intent-filter in the manifest) and the network security
config. Everything else in `android/` is Capacitor-generated.

## Build

Requires Node and Android Studio (its bundled JDK is used — no system Java
needed). `android/local.properties` points at `~/Library/Android/sdk`.

```sh
npm install
npm test                # vitest smoke tests
npm run dev             # browser dev server (share target inert on web)
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
npm run apk             # build web → cap sync → gradle assembleDebug
npm run install-apk     # adb install the debug APK
```

APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

## Behavior notes

- **Series (box sets ingested on the PC — `fullPipe/skills/series`):** rows
  carrying `series`/`ep_no` group under a collapsible header in playlist
  order (`src/series.ts`), the header offers ▶/⬇ for the next unwatched
  episode, and the player shows an *up next* card when an episode ends
  (autoplays after 8 s if the next one is downloaded — Settings → Playback).
  Swipe-delete on a series row is **phone-local**: only the video + sidecars
  leave the phone; the PC keeps everything, ⬇ brings it back.

- **Offline:** downloaded episodes are fully usable without the server. The
  `⬇` bundle is video + subs + transcript + definitions + the prep doc; prep
  docs are also cached on first view and auto-cached for every staged episode
  whenever the queue loads online. The queue screen itself falls back to the
  last `GET /jobs` snapshot when unreachable, with server-only actions
  (curate, delete, download) hidden and everything local still live.
  Every write is a typed action in the outbox — tap batches, mark-watched,
  ratings, even enqueues — flushed FIFO on mark-sync / app-foreground /
  network-return, so an episode's feedback lands before its close-out. Each
  kind is replay-safe (`batch_id` / client `review_id` dedup; watched/enqueue
  idempotent); a permanently rejected action (episode deleted server-side) is
  dropped rather than blocking the queue. Rows with unsynced actions carry a
  `⇪ pending sync` chip, and a queued mark-watched shows as watched. Taps
  accumulate per episode in localStorage and **sync live** (`livesync.ts`):
  a change starts a ~1.2 s debounce, then the episode's whole mark set is
  frozen into one batch (an unsent batch for the same episode is replaced in
  place — the server dedupes per word, so re-sending is free) and the outbox
  flushes. There is no submit button; the prep bar / reader toolbar only
  narrate the state (syncing… / queued / synced ✔). A close-out (Mark watched,
  finished) sends any still-debouncing marks first.
- **Sort + filter** (Queue and Listen tabs, `listfilter.ts`): the sort select
  (newest / oldest / easiest / hardest / longest / shortest / top rated /
  title) plus a filter row — status (to watch · in progress = started and left partway · watched · preparing),
  **genre** (the English label `/immerse` curation gave the episode:
  documentary, vlog, explainer, comedy, interview …, offered only from what's
  on screen), and an **⬇ on phone** toggle for downloaded episodes. Every row
  shows its genre as a chip. Choices persist per tab. On the Listen tab the
  visible order *is* the playlist order, so sorting there reorders what
  "play all" loops through.
- **Now-playing strip** (`nowplaying.ts`): while the background audio service
  is playing — the Listen queue or the player's 🎧 mode — a one-line bar above
  the nav names the episode on every other tab; tap it to open that video in
  the player (which picks the running audio session back up), or ⏯ to pause
  in place. It hides on the Listen tab and on that episode's own player.
- **Progress tab** (`#/progress`): the payoff of the known-lemma ledger, made
  visible — headline tiles (words known, % of the 1,000 most common words,
  episodes watched, cards minted) over **frequency-band coverage bars** (of the
  top 1k/2k/5k/10k most common corpus words, how many are known), plus immersion
  and evidence-provenance counts. From `GET /stats` (ledger-sourced, so it reads
  with Anki closed); the last snapshot caches for an offline glance.
- **Immersion time** (top of Progress, `viewtime.ts`): how long you actually
  spent, **active watching (▶) and passive listening (🎧) counted apart**.
  Today / this-week / all-time tiles, then every week as a collapsible
  **Sunday→Saturday** block (the current week open, older ones folded, weeks
  past the twelfth under "earlier"), days inside, one row per episode with
  its minutes and whether it was **finished** or how far it got ("to 76%").
  What counts is wall-clock time the media was advancing: a rewound stretch
  counts again, a seek / pause / stall counts nothing, playback speed is
  folded out (10 media-minutes at 1.25× = 8 of yours). The player feeds a
  `ViewRecorder` from its timeupdate ticks; passive listening is logged by
  the native service itself (`ListenLog.java` — the webview is dead with the
  screen off) and drained into the same log on app start / foreground /
  Progress open, with the sitting in progress shown live. Sittings are per
  visit, split at midnight, checkpointed every ~5 s so a process kill loses
  almost nothing, and dropped under one second. Only the **Listen tab's
  queue** is passive: the player's 🎧 audio-only mode hands playback to the
  same service but tagged `watch`, so following an episode with the screen
  off still counts as watching. Phone-local (paints instantly, works offline); each closed
  sitting also rides the outbox to `POST /viewtime` (idempotent on its id)
  so the ledger keeps the history, and `GET /viewtime` backfills the local
  log after a reinstall (and re-queues anything the server turned out not to
  hold, so a dropped POST self-heals). A deleted episode keeps its minutes.
  A **weekly goal card** (default 40 h, tap the goal to change it — the
  number sticks on the phone until changed again) shows hours done and
  left this Sunday→Saturday week and the even pace needed over the days
  still open, today included. Active watching only — passive listening
  never counts toward it.
  **"＋ add time"** under the tiles logs immersion done outside the app
  (day · minutes · listening/watching · what): a hand-typed sitting rides
  the same log and outbox, shows with a ✎ and a ✕ (removing it tombstones
  the id locally and issues `DELETE /viewtime/{id}`); recorded and imported
  rows can't be removed from the phone. The pre-app spreadsheet's history
  (`fullPipe/tools/import_tracker_pdf.py`, source `import`) arrives through
  the same `GET /viewtime` merge — one row per show per day, so week bodies
  are built lazily on open.
- **Live paints** (`paint.ts`): the cached sidecars freeze each token's
  known flag at the moment Stage-1 coverage ran and the think-you-know /
  want-to-learn lists at the moment the transcript was pulled. Every
  player / reader / prep open now overlays `GET /episodes/{id}/paint` — the
  ledger's lists as of now, narrowed to that episode — cached per episode
  for offline reopen, plus every word tapped ✓ anywhere on this phone (so a
  mark in one show counts in the next before it has even synced). Known is
  additive; confirm / interest replace the snapshot. Grammar points can't
  be tokens, so the grammar half of the confirm queue is matched against the
  curate pass's per-line patterns: a subtitle line carrying one gets a blue
  `?` badge and the word popup paints the pattern blue with "think you know
  this?".
- **Confirm words** (`#/confirm`, reached from a banner on Progress): the human
  checkpoint that replaced silent exposure→known promotion. The ledger surfaces
  words you've met enough while watching (`GET /confirm`, with JMdict glosses +
  the episodes they appeared in); you answer **✓ I know it** (`POST /confirm`
  known → the word counts as known) or **Not yet** (stays learning, snoozed
  until more exposures). Server-backed.
- **Want-to-learn / Should-know lists** (`#/list/interest`, `#/list/should_know`,
  banners on Progress beside Confirm's): the other two global word lists
  (LIVE_REVIEW.md §1) reviewed with the same card — reading, corpus rank,
  where you've seen it, JMdict gloss (`GET /lists/{name}`). **✓ I know it**
  (`POST /lists/mark` k) takes a word off every list; on the should-know list
  **★ Want to learn** (mark h) pulls it onto the ★ list. Server-backed.
- **Retry a failed job:** a `failed` Stage-1 row now carries a `↻ retry` button
  (`POST /jobs/{id}/retry` re-queues it) instead of forcing a delete-and-repaste.
  Jobs stranded mid-flight by a server restart are reclaimed automatically
  server-side (`jobqueue.reap_stale`) — a stranded card-push resurfaces as the
  existing retry-cards path.
- **Rating + tags:** stars on watched/staged queue rows and the post-watch prep
  bar. Once a star is set, the six taste tags appear (grouped liked/didn't, all
  shown regardless of the star); taps are debounced and append a review via
  `POST /rating {rating, tags}` — re-rating never overwrites, the server's
  on-read verdict takes the latest. Current rating + tags come back on `GET /jobs`.
- **Player** (`#/player/<id>[/<sec>]`): plays the downloaded file
  (Capacitor local server → seek works) — download first from the queue row.
  Subtitles are an overlay built from the tokenized transcript
  (`GET /transcript`, cached at download as `videos/<ep>.transcript.json`) —
  every content word is a tap target feeding the *same* per-episode tap store
  as the prep doc, so watch-time marks sync live like prep-doc marks; plain-SRT
  fallback when no transcript exists. Cues linger until the next line (capped
  +2.5 s) so ASR sentence-end timing doesn't cut subs off early; classic
  white-on-black-outline styling. Prep-doc keywords (curated gloss rows +
  focal points) render orange. Tapping **any** word pops a dictionary card:
  curated gloss/note/focal-why on top (keywords), JMdict senses below (from
  `GET /definitions`, cached at download as `videos/<ep>.definitions.json` —
  needs a one-off `tools.jmdict build` on the PC), and the mark button
  (known ✓ / interest ★) inside — marking moved into the popup.
  `cc` button cycles subtitle modes: on / kw (hidden unless the line carries
  a keyword or ★-marked word) / off. Word highlighting is text-color-only
  (no backgrounds over video; known words stay plain white — absence is the
  signal) and tiered via the `Aa` panel: **off** / **focus** (curated
  keywords orange, ranked candidates coral-bold, the i+1 target coral +
  underline with a small `+1` line badge) / **learn** (+ every unknown word
  dimmed coral, reinforcement targets amber) / **all** (+ known
  corpus-tracked words in a faint blue audit tint). A word marked ✓ goes back
  to plain white; ★ renders violet. Cutting across the tiers: words on the
  ledger's **think-you-know** queue (exposures cleared the bar, awaiting a
  yes/no on the Progress tab) paint light blue at every tier but off — that
  is standing state about the user, not arithmetic about this episode, so it
  outranks the candidate/unknown hues (a curated keyword and the i+1 target
  still win). The page reader paints the same set as a light-blue wash,
  under its `◨ hl` toggle. Tier data rides `GET /transcript`
  (per-sentence `cls`, per-token corpus rank `f`, ranked `candidates`,
  and the narrowed `confirm` list); old
  cached sidecars degrade gracefully (i+1 falls back to a sole-unknown check,
  high-value falls back to prep-glossary lemmas). The `Aa` panel also holds
  subtitle size (0.85–2×) and height (raise the line 0–40% off the bottom
  edge, clear of hardsubs) — global viewing prefs like the cc mode.
  Controls: replay-current-line, prev/next
  line, speed cycle, furigana toggle, fullscreen (+landscape lock), resume
  position (cleared at watched), wake lock while playing. Prep-doc sentence
  timestamps deep-link into the player at that moment. WorkManager
  background pulls (the MOBILE.md decoupled-pull flow) are not built yet.
- First run with no server configured lands on Settings.

## Not yet built

- background video pull (WorkManager, unmetered+charging) + retention/pin UI —
  downloads are manual (⬇ buttons) for now
- deep-link into AnkiDroid
