// Opportunistic outbox flush. Called on app start, on returning online, and
// manually from Settings. Actions are replay-safe (batch_id / review_id dedup,
// idempotent watched/enqueue), so double-flush after a flaky connection is
// harmless.

import { api, ApiError } from "./api";
import { getOutbox, removeFromOutbox } from "./store";
import type { OutboxAction } from "./types";

let flushing = false;

export interface FlushResult {
  sent: number;
  dropped: number;
  remaining: number;
  error?: string;
}

function send(action: OutboxAction): Promise<unknown> {
  switch (action.kind) {
    case "taps":
      return api.postTaps(action.batch);
    case "watched":
      return api.markWatched(action.episode_id, action.cards);
    case "rating":
      return api.rate(
        action.episode_id,
        action.rating,
        action.tags,
        action.review_id,
        action.axes,
        action.follow,
        action.note,
      );
    case "enqueue":
      return api.enqueue(action.source);
    case "passive":
      return api.setPassive(action.episode_id, action.passive);
  }
}

/** A rejection that will never succeed on retry: the episode is gone (404/410),
    the state already moved past this action (409 — e.g. watched while a
    close-out runs), or the payload is malformed (422). Keeping these would
    poison the FIFO queue forever; drop them and let the rest flush. 401 and
    network failures are NOT permanent — fix the token / regain signal. */
function isPermanentRejection(e: unknown): boolean {
  return e instanceof ApiError && [404, 409, 410, 422].includes(e.status ?? 0);
}

export async function flushOutbox(): Promise<FlushResult> {
  if (flushing) return { sent: 0, dropped: 0, remaining: getOutbox().length };
  flushing = true;
  let sent = 0;
  let dropped = 0;
  let error: string | undefined;
  try {
    for (const action of getOutbox()) {
      try {
        await send(action);
        removeFromOutbox(action.id);
        sent++;
      } catch (e) {
        if (isPermanentRejection(e)) {
          removeFromOutbox(action.id);
          dropped++;
          continue;
        }
        error = (e as Error).message;
        break; // server unreachable or rejecting — stop, retry later
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, dropped, remaining: getOutbox().length, error };
}

export function installAutoFlush(onChange?: () => void): void {
  const run = () => {
    if (getOutbox().length) void flushOutbox().then(() => onChange?.());
  };
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") run();
  });
  run();
}
