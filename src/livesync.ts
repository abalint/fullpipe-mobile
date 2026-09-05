// Live mark sync. Every ✓ / ★ made anywhere — prep doc, player popup, page
// reader — reaches the server on its own, the way a list review on the
// Progress tab does (that one POSTs per tap, since it's online-only). Here
// the taps are offline-first, so a change schedules a short debounce, then
// the episode's whole mark set is frozen into one outbox batch and the
// outbox is flushed. Marking three words in a row costs one POST, not
// three; offline, the batch simply waits in the outbox like before. There
// is no submit button any more — the surfaces only *show* sync state.

import { pendingTapCount, submitTaps } from "./store";
import { flushOutbox, type FlushResult } from "./sync";

/** Quiet time after the last mark before the batch is frozen and sent. */
export const TAP_SYNC_DELAY_MS = 1200;

type Listener = (episodeId: string, result: FlushResult | null) => void;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<Listener>();

/** Hear about every completed sync attempt (any episode), to restyle marks
    as committed / refresh a status line. Returns the unsubscribe fn; views
    should also check `root.isConnected` since they have no teardown hook. */
export function onTapSync(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A mark changed: (re)start the debounce for this episode. */
export function scheduleTapSync(episodeId: string): void {
  cancelTapSync(episodeId);
  timers.set(
    episodeId,
    setTimeout(() => {
      timers.delete(episodeId);
      void syncTapsNow(episodeId);
    }, TAP_SYNC_DELAY_MS),
  );
}

/** Drop a pending debounce — call before clearing an episode's taps at
    close-out / delete so the timer can't resurrect a batch afterwards. */
export function cancelTapSync(episodeId: string): void {
  const t = timers.get(episodeId);
  if (t !== undefined) clearTimeout(t);
  timers.delete(episodeId);
}

/** Freeze + flush right now (also cancels any pending debounce). No-op when
    nothing differs from the last frozen baseline. Use before a close-out so
    the taps batch is in the outbox — FIFO — ahead of the watched action, and
    on the wire before an online mark-watched. */
export async function syncTapsNow(episodeId: string): Promise<FlushResult | null> {
  cancelTapSync(episodeId);
  if (!pendingTapCount(episodeId)) return null;
  submitTaps(episodeId);
  const result = await flushOutbox();
  listeners.forEach((fn) => fn(episodeId, result));
  return result;
}

/** True while this episode's debounce is running (a batch is about to be
    frozen). Unflushed batches already in the outbox are the store's business
    (`getOutbox`). */
export function tapSyncPending(episodeId: string): boolean {
  return timers.has(episodeId);
}
