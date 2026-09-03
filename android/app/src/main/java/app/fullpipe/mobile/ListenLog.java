package app.fullpipe.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * Passive-listening time log — the native half of the app's immersion-time
 * record (mobile src/viewtime.ts). The service keeps it because the webview
 * is usually dead while listening happens. One segment per track sitting:
 * wall-clock milliseconds the player was actually playing (pauses count
 * nothing), the furthest position reached, the track length, and the
 * device-local day. Segments close on track change / stop / service death
 * and are split at midnight; the open one is checkpointed every few seconds
 * so a process kill loses almost nothing. Closed segments queue in prefs
 * until JS drains them ({@link #snapshot}) and acks ({@link #ack}) — the
 * same shape as the JS ViewSegment. Kind is "listen" for the Listen tab's
 * passive queue and "watch" when the player handed its episode over for
 * audio-only playback (still active following, just screen-off).
 */
class ListenLog {

    static final String PREFS = "fp_listen_log";
    private static final String KEY_OPEN = "open";
    private static final String KEY_LOG = "log";
    private static final long CHECKPOINT_MS = 5_000;
    /** Anything shorter isn't a sitting. */
    private static final long MIN_SEGMENT_MS = 1_000;

    /** Guards KEY_LOG: the service appends on the main thread while the
        plugin drains/acks on the bridge thread. */
    private static final Object LOCK = new Object();

    private final SharedPreferences prefs;
    private JSONObject open;
    private double openMs;
    private long lastCheckpointAt;

    ListenLog(Context ctx) {
        prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        recover();
    }

    /** A checkpointed segment still in the open slot means the process died
        mid-playback: keep what it had accrued. */
    private void recover() {
        String raw = prefs.getString(KEY_OPEN, null);
        if (raw == null) return;
        prefs.edit().remove(KEY_OPEN).apply();
        try {
            JSONObject seg = new JSONObject(raw);
            if (seg.optDouble("secs", 0) * 1000 >= MIN_SEGMENT_MS) append(seg);
        } catch (JSONException ignored) {
        }
    }

    static String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    private static String nowIso() {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US);
        return f.format(new Date());
    }

    /** Begin a sitting on a track. Closes any sitting still open. `kind` is
        "listen" for the passive queue, "watch" for the player's audio-only
        mode (the episode is still being actively followed). */
    void start(String episodeId, String title, long positionMs, long durationMs, String kind) {
        close();
        if (!"watch".equals(kind)) kind = "listen";
        open = new JSONObject();
        try {
            open.put("id", UUID.randomUUID().toString().replace("-", "").substring(0, 16));
            open.put("episode_id", episodeId);
            open.put("title", title == null ? "" : title);
            open.put("kind", kind);
            open.put("day", today());
            open.put("start", nowIso());
            open.put("secs", 0);
            open.put("reached", Math.max(0, positionMs) / 1000.0);
            open.put("duration", durationMs > 0 ? durationMs / 1000.0 : JSONObject.NULL);
        } catch (JSONException e) {
            open = null;
            return;
        }
        openMs = 0;
        lastCheckpointAt = SystemClock.elapsedRealtime();
    }

    /** The player was playing for `wallDeltaMs` more; it's now at `positionMs`. */
    void tick(long wallDeltaMs, long positionMs, long durationMs) {
        if (open == null) return;
        String day = today();
        if (!day.equals(open.optString("day"))) {
            // midnight: yesterday's seconds close on yesterday; the sitting
            // continues as a fresh segment for today
            String ep = open.optString("episode_id");
            String title = open.optString("title");
            String kind = open.optString("kind", "listen");
            start(ep, title, positionMs, durationMs, kind);
            if (open == null) return;
        }
        if (wallDeltaMs > 0) openMs += wallDeltaMs;
        try {
            open.put("secs", Math.round(openMs / 100.0) / 10.0);
            double pos = Math.max(0, positionMs) / 1000.0;
            if (pos > open.optDouble("reached", 0)) open.put("reached", pos);
            if (durationMs > 0) open.put("duration", durationMs / 1000.0);
        } catch (JSONException ignored) {
        }
        long now = SystemClock.elapsedRealtime();
        if (now - lastCheckpointAt >= CHECKPOINT_MS) {
            lastCheckpointAt = now;
            prefs.edit().putString(KEY_OPEN, open.toString()).apply();
        }
    }

    /** End the sitting: keep it if it holds a second of playback. */
    void close() {
        JSONObject seg = open;
        open = null;
        prefs.edit().remove(KEY_OPEN).apply();
        if (seg == null) return;
        if (openMs < MIN_SEGMENT_MS) return;
        append(seg);
    }

    private void append(JSONObject seg) {
        synchronized (LOCK) {
            JSONArray log = readLog(prefs);
            log.put(seg);
            prefs.edit().putString(KEY_LOG, log.toString()).apply();
        }
    }

    private static JSONArray readLog(SharedPreferences prefs) {
        String raw = prefs.getString(KEY_LOG, null);
        if (raw == null) return new JSONArray();
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /** The sitting in progress (live, not the checkpoint), or null. */
    JSONObject current() {
        return open;
    }

    /** The closed segments awaiting import. Static — works with the service dead. */
    static JSONArray snapshot(Context ctx) {
        synchronized (LOCK) {
            return readLog(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
        }
    }

    /** Drop the segments JS has stored. Static — works with the service dead. */
    static void ack(Context ctx, Set<String> ids) {
        synchronized (LOCK) {
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONArray log = readLog(p);
            JSONArray keep = new JSONArray();
            for (int i = 0; i < log.length(); i++) {
                JSONObject seg = log.optJSONObject(i);
                if (seg != null && !ids.contains(seg.optString("id"))) keep.put(seg);
            }
            p.edit().putString(KEY_LOG, keep.toString()).apply();
        }
    }

    static Set<String> idSet(JSONArray ids) throws JSONException {
        Set<String> out = new HashSet<>();
        if (ids == null) return out;
        for (int i = 0; i < ids.length(); i++) out.add(ids.getString(i));
        return out;
    }
}
