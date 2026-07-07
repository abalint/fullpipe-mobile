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
├── main.ts            app shell: hash router + bottom nav (Queue / Prep / Settings)
├── api.ts             client for the MOBILE.md server API
├── store.ts           settings · per-episode taps · outbox · prep-doc cache (localStorage)
├── sync.ts            opportunistic outbox flush (start / online / visible)
├── prep-render.ts     prep-doc renderer (port of render/template.html)
├── share.ts           JS side of the share-sheet target
├── views/             queue · prep · player · settings
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

- **Offline:** downloaded episodes are fully usable without the server. The
  `⬇` bundle is video + subs + transcript + definitions + the prep doc; prep
  docs are also cached on first view and auto-cached for every staged episode
  whenever the queue loads online. The queue screen itself falls back to the
  last `GET /jobs` snapshot when unreachable, with server-only actions
  (curate, delete, download, stream) hidden and everything local still live.
  Every write is a typed action in the outbox — tap batches, mark-watched,
  ratings, even enqueues — flushed FIFO on submit / app-foreground /
  network-return, so an episode's feedback lands before its close-out. Each
  kind is replay-safe (`batch_id` / client `review_id` dedup; watched/enqueue
  idempotent); a permanently rejected action (episode deleted server-side) is
  dropped rather than blocking the queue. Rows with unsynced actions carry a
  `⇪ pending sync` chip, and a queued mark-watched shows as watched. Taps
  accumulate per episode in localStorage; **Submit** freezes them into a batch.
  "Copy blob" keeps the P9 copy-paste fallback.
- **Submit with no taps** calls `POST /watched/{id}` instead.
- **Rating + tags:** stars on watched/staged queue rows and the post-watch prep
  bar. Once a star is set, the six taste tags appear (grouped liked/didn't, all
  shown regardless of the star); taps are debounced and append a review via
  `POST /rating {rating, tags}` — re-rating never overwrites, the server's
  on-read verdict takes the latest. Current rating + tags come back on `GET /jobs`.
- **Player** (`#/player/<id>[/<sec>]`): plays the downloaded file when present
  (Capacitor local server → seek works), else streams from the sync server.
  Subtitles are an overlay built from the tokenized transcript
  (`GET /transcript`, cached at download as `videos/<ep>.transcript.json`) —
  every content word is a tap target feeding the *same* per-episode tap store
  as the prep doc, so watch-time marks ride the next Submit; plain-SRT
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
  to plain white; ★ renders violet. Tier data rides `GET /transcript`
  (per-sentence `cls`, per-token corpus rank `f`, ranked `candidates`); old
  cached sidecars degrade gracefully (i+1 falls back to a sole-unknown check,
  high-value falls back to prep-glossary lemmas). The `Aa` panel also holds
  subtitle size (0.85–2×) and height (raise the line 0–40% off the bottom
  edge, clear of hardsubs) — global viewing prefs like the cc mode.
  Controls: replay-current-line, prev/next
  line, speed cycle, furigana toggle, fullscreen (+landscape lock), resume
  position (cleared at watched), wake lock while playing. Prep-doc sentence
  timestamps deep-link into the player at that moment. VLC handoff survives
  as a fallback button. WorkManager background pulls (the MOBILE.md
  decoupled-pull flow) are not built yet.
- First run with no server configured lands on Settings.

## Not yet built

- background video pull (WorkManager, unmetered+charging) + retention/pin UI —
  downloads are manual (⬇ buttons) for now
- deep-link into AnkiDroid
