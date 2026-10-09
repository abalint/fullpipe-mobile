package app.fullpipe.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.function.Consumer;

/**
 * Background sound for reading: any number of looping ambience layers (rain,
 * fire, noise — each at its own volume) plus one music channel (a mood's
 * tracks, shuffled). A foreground service so the mix survives the webview
 * being paused or the screen going off.
 *
 * Deliberately NOT a media session and NOT an audio-focus holder: ambience is
 * meant to sit under whatever else plays — the manga reader's voice clips
 * (webview audio), the Listen tab's episode (PassiveAudioService, which
 * pauses on any focus loss), a video. Requesting focus would silence those;
 * holding none means a phone call doesn't pause us either, which is the
 * lesser evil for a rain loop. Headphones unplugging does pause (nobody
 * wants rain out of the speaker on a train).
 *
 * Loops are gapless: each layer runs two MediaPlayers on the same file,
 * the playing one chained to a prepared twin with setNextMediaPlayer, and
 * on completion the twin takes over and a new twin is prepared. The files
 * themselves are crossfaded at the seam on the Mac (tools/ambience.py), so
 * the join is inaudible.
 */
public class AmbienceService extends Service {

    static final String ACTION_START = "app.fullpipe.ambience.START";
    static final String ACTION_TOGGLE = "app.fullpipe.ambience.TOGGLE";
    static final String ACTION_NEXT = "app.fullpipe.ambience.NEXT";
    static final String ACTION_STOP = "app.fullpipe.ambience.STOP";

    private static final String CHANNEL_ID = "ambience";
    private static final int NOTIF_ID = 44;
    /** Music volume while ducked (a voice clip is speaking over it). */
    private static final float DUCK = 0.25f;

    interface StateListener {
        void onStateChanged();
    }

    static volatile StateListener stateListener;
    private static volatile AmbienceService instance;
    /** Work handed over before the service exists (startForegroundService is
        async); drained by onStartCommand. */
    private static final ConcurrentLinkedQueue<Consumer<AmbienceService>> pending =
            new ConcurrentLinkedQueue<>();

    static AmbienceService get() {
        return instance;
    }

    /** Run `fn` on the live service, starting it first if needed. */
    static void run(Context ctx, Consumer<AmbienceService> fn) {
        AmbienceService s = instance;
        if (s != null) {
            s.handler.post(() -> fn.accept(s));
            return;
        }
        pending.add(fn);
        Intent i = new Intent(ctx, AmbienceService.class).setAction(ACTION_START);
        ContextCompat.startForegroundService(ctx, i);
    }

    static class Track {
        final String path;
        final String title;

        Track(String path, String title) {
            this.path = path;
            this.title = title;
        }
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, Loop> loops = new LinkedHashMap<>();
    private final Map<String, String> loopTitles = new LinkedHashMap<>();
    private final List<Track> tracks = new ArrayList<>();
    private final List<Integer> order = new ArrayList<>();
    private int orderPos = -1;
    private MediaPlayer music;
    private boolean musicPrepared = false;
    private float musicVolume = 0.6f;
    private String moodTitle = "";
    private boolean paused = false;
    private boolean ducked = false;
    private final Random random = new Random();

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!paused) pause();
        }
    };

    // --- a gapless loop layer -----------------------------------------------------

    private class Loop {
        final String id;
        final String path;
        float volume;
        MediaPlayer cur;
        MediaPlayer next;
        boolean nextReady = false;
        boolean released = false;

        Loop(String id, String path, float volume) {
            this.id = id;
            this.path = path;
            this.volume = volume;
        }

        private MediaPlayer make() {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build());
            mp.setWakeMode(AmbienceService.this, PowerManager.PARTIAL_WAKE_LOCK);
            float g = gain(volume);
            mp.setVolume(g, g);
            mp.setOnErrorListener((p, what, extra) -> true);
            return mp;
        }

        void start() {
            try {
                cur = make();
                cur.setDataSource(path);
                cur.setOnPreparedListener(mp -> {
                    if (released) return;
                    if (!paused) mp.start();
                    armNext();
                });
                cur.setOnCompletionListener(mp -> onComplete());
                cur.prepareAsync();
            } catch (IOException | IllegalStateException e) {
                release();
            }
        }

        private void armNext() {
            try {
                next = make();
                nextReady = false;
                next.setDataSource(path);
                next.setOnPreparedListener(mp -> {
                    if (released || mp != next) return;
                    nextReady = true;
                    try {
                        cur.setNextMediaPlayer(mp);
                    } catch (IllegalStateException | IllegalArgumentException ignored) {
                    }
                });
                next.setOnCompletionListener(mp -> onComplete());
                next.prepareAsync();
            } catch (IOException | IllegalStateException e) {
                next = null;
            }
        }

        private void onComplete() {
            if (released) return;
            MediaPlayer done = cur;
            if (next != null && nextReady) {
                cur = next; // already playing — chained by setNextMediaPlayer
                next = null;
                if (paused) cur.pause();
                if (done != null) done.release();
                armNext();
            } else {
                if (done != null) done.release();
                if (next != null) next.release();
                next = null;
                start(); // a tiny gap, but never silence
            }
        }

        void setVolume(float v) {
            volume = v;
            apply();
        }

        void apply() {
            float g = gain(volume);
            try {
                if (cur != null) cur.setVolume(g, g);
                if (next != null) next.setVolume(g, g);
            } catch (IllegalStateException ignored) {
            }
        }

        void pause() {
            try {
                if (cur != null && cur.isPlaying()) cur.pause();
            } catch (IllegalStateException ignored) {
            }
        }

        void resume() {
            try {
                if (cur != null && !cur.isPlaying()) cur.start();
            } catch (IllegalStateException ignored) {
            }
        }

        void release() {
            released = true;
            if (cur != null) cur.release();
            if (next != null) next.release();
            cur = null;
            next = null;
        }
    }

    /** Slider value (0–1) → player gain: a square law so the bottom half of
        the slider is usable for quiet background levels. */
    private static float gain(float v) {
        v = Math.max(0f, Math.min(1f, v));
        return v * v;
    }

    // --- lifecycle --------------------------------------------------------------------

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(
                CHANNEL_ID, "Ambience", NotificationManager.IMPORTANCE_LOW));
        ContextCompat.registerReceiver(this, noisyReceiver,
                new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        goForeground(); // every start path, within the 5 s window
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_TOGGLE.equals(action)) {
            toggle();
        } else if (ACTION_NEXT.equals(action)) {
            nextTrack();
        } else if (ACTION_STOP.equals(action)) {
            stopAll();
            return START_NOT_STICKY;
        }
        Consumer<AmbienceService> fn;
        while ((fn = pending.poll()) != null) fn.accept(this);
        if (loops.isEmpty() && music == null) {
            // nothing to play (a stop raced the start) — don't linger
            stopAll();
        }
        return START_NOT_STICKY;
    }

    // --- layers -----------------------------------------------------------------------

    void setLayer(String id, String path, String title, float volume) {
        Loop l = loops.get(id);
        if (l != null && l.path.equals(path)) {
            l.setVolume(volume);
        } else {
            if (l != null) l.release();
            l = new Loop(id, path, volume);
            loops.put(id, l);
            l.start();
        }
        loopTitles.put(id, title);
        changed();
    }

    void removeLayer(String id) {
        Loop l = loops.remove(id);
        loopTitles.remove(id);
        if (l != null) l.release();
        stopIfIdle();
        changed();
    }

    void setLayerVolume(String id, float volume) {
        Loop l = loops.get(id);
        if (l != null) l.setVolume(volume);
        changed();
    }

    // --- music ------------------------------------------------------------------------

    /** Load a mood's tracks. `keep`: if the track now playing is in the new
        list, keep playing it (a mood whose downloads are still landing
        grows without a restart). */
    void setMusic(List<Track> list, String title, float volume, boolean keep) {
        String playing = keep && music != null && orderPos >= 0 && orderPos < order.size()
                ? tracks.get(order.get(orderPos)).path : null;
        tracks.clear();
        tracks.addAll(list);
        moodTitle = title;
        musicVolume = volume;
        order.clear();
        for (int i = 0; i < tracks.size(); i++) order.add(i);
        Collections.shuffle(order, random);
        if (playing != null) {
            int at = -1;
            for (int i = 0; i < tracks.size(); i++) if (tracks.get(i).path.equals(playing)) at = i;
            if (at >= 0) {
                order.remove(Integer.valueOf(at));
                order.add(0, at);
                orderPos = 0;
                applyMusicVolume();
                changed();
                return;
            }
        }
        releaseMusic();
        orderPos = -1;
        if (!tracks.isEmpty()) playOrder(0);
        changed();
    }

    private void playOrder(int pos) {
        releaseMusic();
        if (tracks.isEmpty()) return;
        orderPos = ((pos % order.size()) + order.size()) % order.size();
        Track t = tracks.get(order.get(orderPos));
        try {
            music = new MediaPlayer();
            musicPrepared = false;
            music.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build());
            music.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK);
            music.setDataSource(t.path);
            music.setOnPreparedListener(mp -> {
                musicPrepared = true;
                applyMusicVolume();
                if (!paused) mp.start();
                changed();
            });
            music.setOnCompletionListener(mp -> nextTrack());
            music.setOnErrorListener((mp, what, extra) -> {
                handler.post(this::nextTrack);
                return true;
            });
            music.prepareAsync();
        } catch (IOException | IllegalStateException e) {
            releaseMusic();
            if (tracks.size() > 1) handler.post(() -> playOrder(orderPos + 1));
        }
        changed();
    }

    void nextTrack() {
        if (tracks.isEmpty()) return;
        playOrder(orderPos + 1);
    }

    void previousTrack() {
        if (tracks.isEmpty()) return;
        playOrder(orderPos - 1);
    }

    void stopMusic() {
        releaseMusic();
        tracks.clear();
        order.clear();
        orderPos = -1;
        moodTitle = "";
        stopIfIdle();
        changed();
    }

    void setMusicVolume(float v) {
        musicVolume = v;
        applyMusicVolume();
        changed();
    }

    private void applyMusicVolume() {
        if (music == null) return;
        float g = gain(musicVolume) * (ducked ? DUCK : 1f);
        try {
            music.setVolume(g, g);
        } catch (IllegalStateException ignored) {
        }
    }

    private void releaseMusic() {
        if (music != null) {
            try {
                music.release();
            } catch (IllegalStateException ignored) {
            }
        }
        music = null;
        musicPrepared = false;
    }

    // --- transport --------------------------------------------------------------------

    void pause() {
        paused = true;
        for (Loop l : loops.values()) l.pause();
        try {
            if (music != null && musicPrepared && music.isPlaying()) music.pause();
        } catch (IllegalStateException ignored) {
        }
        changed();
    }

    void resume() {
        paused = false;
        for (Loop l : loops.values()) l.resume();
        try {
            if (music != null && musicPrepared && !music.isPlaying()) music.start();
        } catch (IllegalStateException ignored) {
        }
        changed();
    }

    void toggle() {
        if (paused) resume();
        else pause();
    }

    /** Voice clip speaking over the mix: music drops to a murmur, loops stay
        (rain under a voice is fine; a song fighting it is not). */
    void setDuck(boolean on) {
        ducked = on;
        applyMusicVolume();
    }

    void stopAll() {
        for (Loop l : loops.values()) l.release();
        loops.clear();
        loopTitles.clear();
        releaseMusic();
        tracks.clear();
        order.clear();
        orderPos = -1;
        moodTitle = "";
        paused = false;
        changed();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void stopIfIdle() {
        if (loops.isEmpty() && tracks.isEmpty()) stopAll();
    }

    // --- state ------------------------------------------------------------------------

    boolean isRunning() {
        return !loops.isEmpty() || !tracks.isEmpty();
    }

    boolean isPaused() {
        return paused;
    }

    List<String> layerIds() {
        return new ArrayList<>(loops.keySet());
    }

    float layerVolume(String id) {
        Loop l = loops.get(id);
        return l != null ? l.volume : 0f;
    }

    boolean hasMusic() {
        return !tracks.isEmpty();
    }

    String musicTitle() {
        if (orderPos < 0 || orderPos >= order.size()) return "";
        return tracks.get(order.get(orderPos)).title;
    }

    String musicPath() {
        if (orderPos < 0 || orderPos >= order.size()) return "";
        return tracks.get(order.get(orderPos)).path;
    }

    String moodTitle() {
        return moodTitle;
    }

    float musicVolume() {
        return musicVolume;
    }

    int trackCount() {
        return tracks.size();
    }

    private void changed() {
        StateListener l = stateListener;
        if (l != null) l.onStateChanged();
        if (isRunning()) goForeground();
    }

    private String describe() {
        List<String> parts = new ArrayList<>(loopTitles.values());
        if (!moodTitle.isEmpty()) parts.add(moodTitle);
        return parts.isEmpty() ? "ambience" : String.join(" · ", parts);
    }

    private PendingIntent serviceIntent(String action) {
        Intent i = new Intent(this, AmbienceService.class).setAction(action);
        return PendingIntent.getService(this, action.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void goForeground() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
                .setContentTitle(paused ? "Ambience paused" : "Ambience")
                .setContentText(describe())
                .setContentIntent(tap)
                .setDeleteIntent(serviceIntent(ACTION_STOP))
                .setOngoing(!paused)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .addAction(paused ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause,
                        paused ? "resume" : "pause", serviceIntent(ACTION_TOGGLE));
        if (!tracks.isEmpty())
            b.addAction(android.R.drawable.ic_media_next, "next", serviceIntent(ACTION_NEXT));
        b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "stop", serviceIntent(ACTION_STOP));
        b.setVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
        ServiceCompat.startForeground(this, NOTIF_ID, b.build(), type);
    }

    @Override
    public void onDestroy() {
        for (Loop l : loops.values()) l.release();
        loops.clear();
        releaseMusic();
        unregisterReceiver(noisyReceiver);
        instance = null;
        StateListener l = stateListener;
        if (l != null) l.onStateChanged();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
