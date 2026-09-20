package app.fullpipe.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Episode downloads as a foreground data-sync service. The webview used to
 * pull videos itself (Filesystem.downloadFile), which dies the moment the app
 * leaves the foreground — Android pauses the webview and then reaps the
 * process. Here the plugin hands jobs to a static queue, this service drains
 * it one episode at a time on a worker thread behind an ongoing progress
 * notification, and each finished episode is parked in SharedPreferences
 * until the JS side has written its VideoRecord and acked it — so a result
 * that lands while the webview is gone is picked up on the next app open.
 *
 * Files are written to <files>/<path> (Capacitor's Directory.Data) via a
 * .part file, so the paths the player and passive service already use don't
 * change. The video is fetched with a Range header when a .part is left
 * over, so a killed download resumes instead of starting over.
 */
public class VideoDownloadService extends Service {

    static final String ACTION_ENQUEUE = "app.fullpipe.mobile.download.ENQUEUE";

    private static final String CHANNEL_ID = "video_downloads";
    private static final int NOTIF_ID = 42;
    private static final int NOTIF_SUMMARY_ID = 43;
    /** ep → result JSON, awaiting the JS ack (VideoDownloadPlugin.ack). */
    static final String RESULTS_PREFS = "fp_video_downloads";
    private static final int ATTEMPTS = 3;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    private static final long PROGRESS_EVERY_MS = 250;
    private static final long NOTIF_EVERY_MS = 1_000;

    static class FileSpec {
        final String url;
        /** Relative to getFilesDir() (Capacitor Directory.Data). */
        final String path;
        /** A required file failing fails the episode; the rest are best-effort sidecars. */
        final boolean required;

        FileSpec(String url, String path, boolean required) {
            this.url = url;
            this.path = path;
            this.required = required;
        }
    }

    static class Job {
        final String episodeId;
        final String title;
        final List<FileSpec> files;
        final Map<String, String> headers;

        Job(String episodeId, String title, List<FileSpec> files, Map<String, String> headers) {
            this.episodeId = episodeId;
            this.title = title;
            this.files = files;
            this.headers = headers;
        }
    }

    interface Listener {
        void onProgress(String episodeId, long bytes, long total, String phase);

        void onDone(String episodeId, JSONObject result);
    }

    /** The plugin's ear; static so it survives webview reloads. */
    static volatile Listener listener;

    private static final Object lock = new Object();
    private static final ArrayDeque<Job> queue = new ArrayDeque<>();
    private static Job current;
    private static long currentBytes = 0;
    private static long currentTotal = -1;
    private static String currentPhase = "queued";
    private static volatile VideoDownloadService instance;

    /** Queue an episode (no-op when it's already queued or in flight). The
        caller then starts the service with ACTION_ENQUEUE. */
    static boolean offer(Job job) {
        synchronized (lock) {
            if (current != null && current.episodeId.equals(job.episodeId)) return false;
            for (Job j : queue) if (j.episodeId.equals(job.episodeId)) return false;
            queue.add(job);
            return true;
        }
    }

    /** Snapshot for the plugin's getState(): the job in flight first, then
        the waiting ones. */
    static List<JSONObject> activeSnapshot() {
        List<JSONObject> out = new ArrayList<>();
        synchronized (lock) {
            try {
                if (current != null) {
                    JSONObject o = new JSONObject();
                    o.put("episodeId", current.episodeId);
                    o.put("bytes", currentBytes);
                    o.put("total", currentTotal);
                    o.put("phase", currentPhase);
                    out.add(o);
                }
                for (Job j : queue) {
                    JSONObject o = new JSONObject();
                    o.put("episodeId", j.episodeId);
                    o.put("bytes", 0);
                    o.put("total", -1);
                    o.put("phase", "queued");
                    out.add(o);
                }
            } catch (JSONException ignored) {
            }
        }
        return out;
    }

    static VideoDownloadService get() {
        return instance;
    }

    private Thread worker;
    private PowerManager.WakeLock wakeLock;
    private NotificationManager notifications;
    private long lastNotifAt = 0;
    private int finishedOk = 0;
    private final List<String> failedTitles = new ArrayList<>();

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        notifications = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Video downloads", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Episode downloads running in the background");
            ch.setShowBadge(false);
            notifications.createNotificationChannel(ch);
        }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fullpipe:download");
        wakeLock.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // must be in the foreground within seconds of startForegroundService,
        // whatever the intent was
        goForeground(buildNotification());
        synchronized (lock) {
            if (worker == null || !worker.isAlive()) {
                worker = new Thread(this::drain, "fp-download");
                worker.start();
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        instance = null;
        if (wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    /** Android 15 caps dataSync services at a few hours a day — if we ever hit
        it, stop cleanly; unfinished episodes resume from their .part later. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        synchronized (lock) {
            queue.clear();
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void goForeground(Notification n) {
        if (Build.VERSION.SDK_INT >= 29) {
            ServiceCompat.startForeground(this, NOTIF_ID, n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    // --- worker ----------------------------------------------------------------

    private void drain() {
        wakeLock.acquire(6 * 60 * 60 * 1000L);
        try {
            while (true) {
                Job job;
                synchronized (lock) {
                    job = queue.poll();
                    current = job;
                    currentBytes = 0;
                    currentTotal = -1;
                    currentPhase = job == null ? "queued" : "video";
                }
                if (job == null) break;
                lastNotifAt = 0;
                notifications.notify(NOTIF_ID, buildNotification());
                JSONObject result = run(job);
                synchronized (lock) {
                    current = null;
                }
                storeResult(job.episodeId, result);
                if (result.optBoolean("ok")) finishedOk++;
                else failedTitles.add(job.title);
                Listener l = listener;
                if (l != null) l.onDone(job.episodeId, result);
            }
        } finally {
            if (wakeLock.isHeld()) wakeLock.release();
            postSummary();
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    }

    private JSONObject run(Job job) {
        JSONObject result = new JSONObject();
        JSONObject files = new JSONObject();
        boolean ok = true;
        String error = null;
        try {
            result.put("episodeId", job.episodeId);
            for (FileSpec f : job.files) {
                synchronized (lock) {
                    currentPhase = f.required ? "video" : "sidecars";
                }
                try {
                    download(f, job);
                    files.put(f.path, true);
                } catch (IOException e) {
                    files.put(f.path, false);
                    if (f.required) {
                        ok = false;
                        error = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                        break;
                    }
                }
            }
            result.put("ok", ok);
            if (error != null) result.put("error", error);
            result.put("files", files);
            result.put("at", System.currentTimeMillis());
        } catch (JSONException ignored) {
        }
        return result;
    }

    /** One file, three attempts, resuming a leftover .part with a Range
        request. HTTP 4xx/5xx is final (no point retrying a 404); connection
        drops retry after a short pause. */
    private void download(FileSpec f, Job job) throws IOException {
        File dest = new File(getFilesDir(), f.path);
        File part = new File(dest.getPath() + ".part");
        File dir = dest.getParentFile();
        if (dir != null && !dir.exists() && !dir.mkdirs() && !dir.exists())
            throw new IOException("cannot create " + dir);
        IOException last = null;
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            if (attempt > 0) SystemClock.sleep(1500L * attempt);
            long have = part.exists() ? part.length() : 0;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(f.url).openConnection();
                c.setConnectTimeout(CONNECT_TIMEOUT_MS);
                c.setReadTimeout(READ_TIMEOUT_MS);
                c.setInstanceFollowRedirects(true);
                // identity keeps Content-Length meaningful for the progress bar
                c.setRequestProperty("Accept-Encoding", "identity");
                for (Map.Entry<String, String> h : job.headers.entrySet())
                    c.setRequestProperty(h.getKey(), h.getValue());
                if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
                int code = c.getResponseCode();
                boolean append;
                if (code == 206 && have > 0) {
                    append = true;
                } else if (code == 416) {
                    // the .part outgrew the file (server re-staged it) — start over
                    if (!part.delete()) throw new IOException("cannot reset " + part);
                    last = new IOException("HTTP 416");
                    continue;
                } else if (code >= 200 && code < 300) {
                    append = false;
                } else {
                    throw new HttpStatusException(code);
                }
                long len = c.getContentLengthLong();
                long done = append ? have : 0;
                long total = len >= 0 ? done + len : -1;
                long lastReport = 0;
                try (InputStream in = c.getInputStream();
                     OutputStream out = new FileOutputStream(part, append)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        long now = SystemClock.elapsedRealtime();
                        if (f.required && now - lastReport >= PROGRESS_EVERY_MS) {
                            lastReport = now;
                            report(job, done, total);
                        }
                    }
                }
                if (total >= 0 && done != total)
                    throw new IOException("connection dropped at " + done + "/" + total);
                if (f.required) report(job, done, total >= 0 ? total : done);
                if (dest.exists() && !dest.delete()) throw new IOException("cannot replace " + dest);
                if (!part.renameTo(dest)) throw new IOException("cannot move " + part);
                return;
            } catch (HttpStatusException e) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                throw e;
            } catch (IOException e) {
                last = e;
            } finally {
                if (c != null) c.disconnect();
            }
        }
        //noinspection ResultOfMethodCallIgnored
        part.delete();
        throw last != null ? last : new IOException("download failed");
    }

    private static class HttpStatusException extends IOException {
        HttpStatusException(int code) {
            super("HTTP " + code);
        }
    }

    private void report(Job job, long bytes, long total) {
        String phase;
        synchronized (lock) {
            currentBytes = bytes;
            currentTotal = total;
            phase = currentPhase;
        }
        Listener l = listener;
        if (l != null) l.onProgress(job.episodeId, bytes, total, phase);
        long now = SystemClock.elapsedRealtime();
        if (now - lastNotifAt >= NOTIF_EVERY_MS) {
            lastNotifAt = now;
            notifications.notify(NOTIF_ID, buildNotification());
        }
    }

    // --- results awaiting the JS ack -------------------------------------------

    private void storeResult(String episodeId, JSONObject result) {
        SharedPreferences prefs = getSharedPreferences(RESULTS_PREFS, MODE_PRIVATE);
        prefs.edit().putString(episodeId, result.toString()).apply();
    }

    static List<JSONObject> pendingResults(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(RESULTS_PREFS, MODE_PRIVATE);
        List<JSONObject> out = new ArrayList<>();
        for (Object v : prefs.getAll().values()) {
            try {
                out.add(new JSONObject(String.valueOf(v)));
            } catch (JSONException ignored) {
            }
        }
        return out;
    }

    static void ack(Context ctx, List<String> episodeIds) {
        SharedPreferences.Editor e = ctx.getSharedPreferences(RESULTS_PREFS, MODE_PRIVATE).edit();
        for (String id : episodeIds) e.remove(id);
        e.apply();
    }

    // --- notifications ---------------------------------------------------------

    private Notification buildNotification() {
        Job job;
        long bytes;
        long total;
        String phase;
        int waiting;
        synchronized (lock) {
            job = current;
            bytes = currentBytes;
            total = currentTotal;
            phase = currentPhase;
            waiting = queue.size();
        }
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setContentIntent(openApp())
                .setPriority(NotificationCompat.PRIORITY_LOW);
        if (job == null) {
            b.setContentTitle("Preparing download…").setProgress(0, 0, true);
        } else {
            b.setContentTitle(job.title);
            String more = waiting > 0 ? " · " + waiting + " more queued" : "";
            if ("sidecars".equals(phase)) {
                b.setContentText("finishing" + more).setProgress(0, 0, true);
            } else if (total > 0) {
                int pct = (int) Math.min(100, bytes * 100 / total);
                b.setContentText(pct + "% · " + mb(bytes) + " / " + mb(total) + more)
                        .setProgress(100, pct, false);
            } else {
                b.setContentText(mb(bytes) + more).setProgress(0, 0, true);
            }
        }
        return b.build();
    }

    /** One quiet line when the queue drains with failures in it; a clean run
        just takes its ongoing notification away. */
    private void postSummary() {
        if (failedTitles.isEmpty()) return;
        StringBuilder text = new StringBuilder();
        for (String t : failedTitles) {
            if (text.length() > 0) text.append(", ");
            text.append(t);
        }
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle(failedTitles.size() + " download" + (failedTitles.size() == 1 ? "" : "s")
                        + " failed" + (finishedOk > 0 ? " · " + finishedOk + " done" : ""))
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(openApp())
                .setAutoCancel(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
        notifications.notify(NOTIF_SUMMARY_ID, n);
        failedTitles.clear();
        finishedOk = 0;
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(this, 0, i, flags);
    }

    private static String mb(long bytes) {
        return bytes >= 1_000_000_000L
                ? String.format(java.util.Locale.US, "%.1f GB", bytes / 1e9)
                : Math.round(bytes / 1e6) + " MB";
    }
}
