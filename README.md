# fullPipe mobile — Android client

The phone side of `fullPipe/MOBILE.md`: queue screen · prep-doc viewer with
know/don't-know taps · tap outbox with idempotent sync · video player with the
analysis subs · 1–5★ rating + taste-tag picker · Android share-sheet enqueue
target. Capacitor (web UI wrapped
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

- **Offline:** prep docs are cached on first view; the queue screen lists
  cached docs when the server is unreachable. Taps accumulate per episode in
  localStorage; **Submit** freezes them into a batch (client `batch_id` →
  replay-idempotent) in the outbox, which flushes on submit / app-foreground /
  network-return. "Copy blob" keeps the P9 copy-paste fallback.
- **Submit with no taps** calls `POST /watched/{id}` instead.
- **Rating + tags:** stars on watched/staged queue rows and the post-watch prep
  bar. Once a star is set, the six taste tags appear (grouped liked/didn't, all
  shown regardless of the star); taps are debounced and append a review via
  `POST /rating {rating, tags}` — re-rating never overwrites, the server's
  on-read verdict takes the latest. Current rating + tags come back on `GET /jobs`.
- **Video** streams from the server (HTTP range → seeking works) with the SRT
  sidecar converted to WebVTT in memory. Local video caching + WorkManager
  background pulls (the MOBILE.md decoupled-pull flow) are not built yet.
- First run with no server configured lands on Settings.

## Not yet built

- background video pull (WorkManager, unmetered+charging) + retention/pin UI —
  the player currently streams from the server instead
- deep-link into AnkiDroid
