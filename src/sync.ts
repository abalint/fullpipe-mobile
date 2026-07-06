// Opportunistic outbox flush. Called on app start, on returning online, and
// manually from Settings. Batches are idempotent (batch_id), so double-flush
// after a flaky connection is harmless.

import { api } from "./api";
import { getOutbox, removeFromOutbox } from "./store";

let flushing = false;

export interface FlushResult {
  sent: number;
  remaining: number;
  error?: string;
}

export async function flushOutbox(): Promise<FlushResult> {
  if (flushing) return { sent: 0, remaining: getOutbox().length };
  flushing = true;
  let sent = 0;
  let error: string | undefined;
  try {
    for (const batch of getOutbox()) {
      try {
        await api.postTaps(batch);
        removeFromOutbox(batch.batch_id);
        sent++;
      } catch (e) {
        error = (e as Error).message;
        break; // server unreachable or rejecting — stop, retry later
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, remaining: getOutbox().length, error };
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
