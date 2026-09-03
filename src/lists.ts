// The ledger's "we think you know this; do you?" queue (server: GET
// /transcript → `confirm`), already narrowed to the lemmas that appear in
// this episode/thread. It is the user's own standing state — a word sits
// there across shows until it's answered on the Progress tab — so every
// reading surface paints it blue, cutting across the episode-local
// highlighting. Absent on sidecars downloaded before the list existed → an
// empty set, and the surfaces just fall back to their usual marks.
// ("Want to learn" needs nothing here: ★-tapped words already paint violet
// through the tap store.)

import type { TranscriptDoc } from "./types";

export const NO_CONFIRM: ReadonlySet<string> = new Set<string>();

export function confirmList(doc: TranscriptDoc | null | undefined): ReadonlySet<string> {
  return new Set(doc?.confirm ?? []);
}
