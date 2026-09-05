// Live mark sync (livesync.ts): marks freeze into one outbox batch after a
// short quiet period and flush on their own — the submit button is gone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TAP_SYNC_DELAY_MS,
  cancelTapSync,
  onTapSync,
  scheduleTapSync,
  syncTapsNow,
} from "./livesync";
import {
  cycleTap,
  getOutbox,
  getSubmitted,
  pendingTapCount,
  queueWatched,
  saveSettings,
  submitTaps,
} from "./store";

const EP = "yt_live";

beforeEach(() => {
  localStorage.clear();
  saveSettings({ serverUrl: "http://pc.ts.net:8321", token: "tok" });
  vi.useFakeTimers();
  // unreachable by default: batches freeze and stay queued
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("scheduleTapSync", () => {
  it("coalesces a burst of marks into one batch after the quiet period", async () => {
    cycleTap(EP, "犬");
    scheduleTapSync(EP);
    await vi.advanceTimersByTimeAsync(TAP_SYNC_DELAY_MS / 2);
    cycleTap(EP, "猫");
    scheduleTapSync(EP); // restarts the debounce
    await vi.advanceTimersByTimeAsync(TAP_SYNC_DELAY_MS / 2 + 10);
    expect(getOutbox().length).toBe(0); // still inside the second quiet period
    await vi.advanceTimersByTimeAsync(TAP_SYNC_DELAY_MS / 2 + 10);
    const out = getOutbox();
    expect(out.length).toBe(1);
    expect(out[0].kind === "taps" && out[0].batch.taps.length).toBe(2);
    expect(pendingTapCount(EP)).toBe(0); // baseline = what was frozen
    expect(getSubmitted(EP)).toEqual({ 犬: "k", 猫: "k" });
  });

  it("flushes the batch when the server is reachable and tells listeners", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        posted.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ applied: 1 }), { status: 200 });
      }),
    );
    const heard: string[] = [];
    const off = onTapSync((ep, res) => heard.push(`${ep}:${res?.sent}`));
    cycleTap(EP, "犬");
    scheduleTapSync(EP);
    await vi.advanceTimersByTimeAsync(TAP_SYNC_DELAY_MS + 10);
    expect(posted.length).toBe(1);
    expect(getOutbox().length).toBe(0);
    expect(heard).toEqual([`${EP}:1`]);
    off();
  });

  it("cancelTapSync stops a pending debounce; syncTapsNow with nothing pending is a no-op", async () => {
    cycleTap(EP, "犬");
    scheduleTapSync(EP);
    cancelTapSync(EP);
    await vi.advanceTimersByTimeAsync(TAP_SYNC_DELAY_MS * 2);
    expect(getOutbox().length).toBe(0);
    submitTaps(EP);
    expect(await syncTapsNow(EP)).toBeNull(); // baseline already current
    expect(getOutbox().length).toBe(1);
  });

  it("syncTapsNow freezes immediately, cancelling the debounce", async () => {
    cycleTap(EP, "犬");
    scheduleTapSync(EP);
    const res = await syncTapsNow(EP);
    expect(res?.remaining).toBe(1); // offline → queued
    await vi.advanceTimersByTimeAsync(TAP_SYNC_DELAY_MS * 2);
    expect(getOutbox().length).toBe(1); // the timer did not add a second one
  });
});

describe("submitTaps coalescing", () => {
  it("replaces an unsent batch for the episode in place, keeping its FIFO slot", () => {
    cycleTap(EP, "犬");
    submitTaps(EP);
    queueWatched(EP, false);
    cycleTap(EP, "猫");
    submitTaps(EP); // superset snapshot supersedes the unsent one
    const out = getOutbox();
    expect(out.map((a) => a.kind)).toEqual(["taps", "watched"]); // still ahead of the watched
    expect(out[0].kind === "taps" && out[0].batch.taps.length).toBe(2);
  });

  it("leaves other episodes' batches alone", () => {
    cycleTap(EP, "犬");
    submitTaps(EP);
    cycleTap("yt_other", "猫");
    submitTaps("yt_other");
    submitTaps(EP);
    expect(getOutbox().filter((a) => a.kind === "taps").length).toBe(2);
  });
});
