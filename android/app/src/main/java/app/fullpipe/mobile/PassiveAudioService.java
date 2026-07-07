package app.fullpipe.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Passive-listening playback: a foreground media service looping a playlist
 * of downloaded episode files (the mp4's audio track) like an mp3 player.
 * The MediaSession puts play/pause/prev/next on the lock screen, bluetooth
 * buttons work, and the foreground notification keeps Android from killing
 * playback with the screen off. The playlist is handed over in-process via
 * {@link #pendingLoad} (same-process static — no Parcelable ceremony).
 */
public class PassiveAudioService extends Service {

    static final String ACTION_LOAD = "app.fullpipe.mobile.passive.LOAD";
    static final String ACTION_TOGGLE = "app.fullpipe.mobile.passive.TOGGLE";
    static final String ACTION_NEXT = "app.fullpipe.mobile.passive.NEXT";
    static final String ACTION_PREV = "app.fullpipe.mobile.passive.PREV";
    static final String ACTION_STOP = "app.fullpipe.mobile.passive.STOP";

    private static final String CHANNEL_ID = "passive_audio";
    private static final int NOTIF_ID = 41;

    static class Track {
        final String path;
        final String title;
        final String episodeId;

        Track(String path, String title, String episodeId) {
            this.path = path;
            this.title = title;
            this.episodeId = episodeId;
        }
    }

    static class Load {
        final List<Track> tracks;
        final int startIndex;
        final float speed;

        Load(List<Track> tracks, int startIndex, float speed) {
            this.tracks = tracks;
            this.startIndex = startIndex;
            this.speed = speed;
        }
    }

    /** Playlist handoff from the plugin; consumed by the next ACTION_LOAD. */
    static volatile Load pendingLoad;

    interface StateListener {
        void onStateChanged();
    }

    /** The plugin's ear; static so the service survives webview reloads. */
    static volatile StateListener stateListener;

    private static volatile PassiveAudioService instance;

    static PassiveAudioService get() {
        return instance;
    }

    private final List<Track> tracks = new ArrayList<>();
    private int index = -1;
    private boolean playing = false;
    private float speed = 1f;
    private MediaPlayer player;
    private MediaSessionCompat session;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private boolean resumeOnFocusGain = false;

    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS:
                resumeOnFocusGain = false;
                pause();
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                resumeOnFocusGain = playing;
                pause();
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                if (resumeOnFocusGain) {
                    resumeOnFocusGain = false;
                    resume();
                }
                break;
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(
                CHANNEL_ID, "Passive listening", NotificationManager.IMPORTANCE_LOW));

        session = new MediaSessionCompat(this, "fullpipe-passive");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                resume();
            }

            @Override
            public void onPause() {
                pause();
            }

            @Override
            public void onSkipToNext() {
                next();
            }

            @Override
            public void onSkipToPrevious() {
                previous();
            }

            @Override
            public void onStop() {
                stopPlayback();
            }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // foreground promptly on every start — required after startForegroundService
        goForeground();
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_LOAD.equals(action)) {
            Load load = pendingLoad;
            pendingLoad = null;
            if (load != null && !load.tracks.isEmpty()) {
                tracks.clear();
                tracks.addAll(load.tracks);
                speed = load.speed;
                startAt(Math.max(0, Math.min(load.startIndex, tracks.size() - 1)));
            }
        } else if (ACTION_TOGGLE.equals(action)) {
            toggle();
        } else if (ACTION_NEXT.equals(action)) {
            next();
        } else if (ACTION_PREV.equals(action)) {
            previous();
        } else if (ACTION_STOP.equals(action)) {
            stopPlayback();
        }
        return START_NOT_STICKY;
    }

    // --- playback ----------------------------------------------------------

    private void startAt(int i) {
        releasePlayer();
        if (tracks.isEmpty()) return;
        index = ((i % tracks.size()) + tracks.size()) % tracks.size();
        Track track = tracks.get(index);
        player = new MediaPlayer();
        player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
        player.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK);
        try {
            player.setDataSource(track.path);
        } catch (IOException e) {
            // unreadable file (deleted underneath us) — skip it, but never
            // spin forever on a playlist where every file is gone
            tracks.remove(index);
            if (!tracks.isEmpty()) startAt(index);
            else stopPlayback();
            return;
        }
        player.setOnPreparedListener(mp -> {
            applySpeed();
            requestFocus();
            mp.start();
            playing = true;
            publish();
        });
        // repeat-all: the whole point is looping relistens
        player.setOnCompletionListener(mp -> startAt(index + 1));
        player.setOnErrorListener((mp, what, extra) -> {
            startAt(index + 1);
            return true;
        });
        player.prepareAsync();
        publish();
    }

    private void applySpeed() {
        if (player == null) return;
        try {
            player.setPlaybackParams(player.getPlaybackParams().setSpeed(speed));
        } catch (IllegalArgumentException | IllegalStateException e) {
            /* device rejects the rate — play at 1× rather than die */
        }
    }

    void toggle() {
        if (playing) pause();
        else resume();
    }

    void pause() {
        if (player != null && playing) {
            player.pause();
            playing = false;
            publish();
        }
    }

    void resume() {
        if (player != null && !playing) {
            requestFocus();
            player.start();
            applySpeed();
            playing = true;
            publish();
        }
    }

    void next() {
        if (!tracks.isEmpty()) startAt(index + 1);
    }

    /** Restart the current track when it's underway, else the previous one. */
    void previous() {
        if (tracks.isEmpty()) return;
        if (player != null && currentPosition() > 3000) startAt(index);
        else startAt(index - 1);
    }

    void setSpeed(float s) {
        speed = s;
        // MediaPlayer quirk: setPlaybackParams on a paused player starts it,
        // so only touch it while playing — resume() re-applies otherwise
        if (playing) applySpeed();
        publish();
    }

    void stopPlayback() {
        releasePlayer();
        tracks.clear();
        index = -1;
        playing = false;
        abandonFocus();
        publish();
        stopForeground(true);
        stopSelf();
    }

    private void releasePlayer() {
        if (player != null) {
            try {
                player.release();
            } catch (Exception ignored) {
            }
            player = null;
        }
        playing = false;
    }

    private void requestFocus() {
        if (focusRequest == null) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setOnAudioFocusChangeListener(focusListener)
                    .build();
        }
        audioManager.requestAudioFocus(focusRequest);
    }

    private void abandonFocus() {
        if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
    }

    // --- state out ---------------------------------------------------------

    boolean isRunning() {
        return !tracks.isEmpty();
    }

    boolean isPlaying() {
        return playing;
    }

    int getIndex() {
        return index;
    }

    float getSpeed() {
        return speed;
    }

    String currentEpisodeId() {
        return index >= 0 && index < tracks.size() ? tracks.get(index).episodeId : null;
    }

    private String currentTitle() {
        return index >= 0 && index < tracks.size() ? tracks.get(index).title : "";
    }

    private long currentPosition() {
        try {
            return player != null ? player.getCurrentPosition() : 0;
        } catch (IllegalStateException e) {
            return 0;
        }
    }

    /** Session + notification + JS all learn about every state change here. */
    private void publish() {
        long actions = PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_STOP
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;
        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(playing ? PlaybackStateCompat.STATE_PLAYING
                        : PlaybackStateCompat.STATE_PAUSED, currentPosition(), speed)
                .build());
        session.setMetadata(new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle())
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, "passive listening")
                .build());
        goForeground();
        StateListener l = stateListener;
        if (l != null) l.onStateChanged();
    }

    private PendingIntent serviceIntent(String action) {
        Intent i = new Intent(this, PassiveAudioService.class).setAction(action);
        return PendingIntent.getService(this, action.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void goForeground() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notif = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(currentTitle().isEmpty() ? "Passive listening" : currentTitle())
                .setContentText("passive listening")
                .setContentIntent(tap)
                .setDeleteIntent(serviceIntent(ACTION_STOP))
                .setOngoing(playing)
                .setOnlyAlertOnce(true)
                .addAction(android.R.drawable.ic_media_previous, "prev", serviceIntent(ACTION_PREV))
                .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "pause" : "play", serviceIntent(ACTION_TOGGLE))
                .addAction(android.R.drawable.ic_media_next, "next", serviceIntent(ACTION_NEXT))
                .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2))
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .build();
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
        ServiceCompat.startForeground(this, NOTIF_ID, notif, type);
    }

    @Override
    public void onDestroy() {
        releasePlayer();
        abandonFocus();
        session.release();
        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
