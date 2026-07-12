package app.fullpipe.mobile;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * JS bridge for the passive-listening player (PassiveAudioService). play()
 * hands the playlist to the foreground service; the rest are transport
 * controls. State changes stream back to JS as "state" events so the Listen
 * tab can mirror what the lock screen shows.
 */
@CapacitorPlugin(
        name = "PassiveAudio",
        permissions = @Permission(
                strings = {"android.permission.POST_NOTIFICATIONS"},
                alias = "notifications"))
public class PassiveAudioPlugin extends Plugin {

    @Override
    public void load() {
        // notifyListeners is bridge-thread-safe; the activity may already be
        // gone while the service plays on, so don't touch it here
        PassiveAudioService.stateListener = () -> notifyListeners("state", state());
    }

    private JSObject state() {
        PassiveAudioService s = PassiveAudioService.get();
        JSObject o = new JSObject();
        o.put("running", s != null && s.isRunning());
        o.put("playing", s != null && s.isPlaying());
        o.put("index", s != null ? s.getIndex() : -1);
        o.put("speed", s != null ? s.getSpeed() : 1f);
        o.put("positionMs", s != null ? s.getPositionMs() : 0);
        o.put("durationMs", s != null ? s.getDurationMs() : 0);
        o.put("sleepRemainingMs", s != null ? s.getSleepRemainingMs() : 0);
        String ep = s != null ? s.currentEpisodeId() : null;
        if (ep != null) o.put("episodeId", ep);
        return o;
    }

    @PluginMethod
    public void play(PluginCall call) {
        // media notification needs POST_NOTIFICATIONS on 13+; playback itself
        // works either way, so ask once and start regardless of the answer
        if (Build.VERSION.SDK_INT >= 33
                && getPermissionState("notifications") != PermissionState.GRANTED
                && !call.getBoolean("_retried", false)) {
            requestPermissionForAlias("notifications", call, "notifPermDone");
            return;
        }
        startPlayback(call);
    }

    @PermissionCallback
    private void notifPermDone(PluginCall call) {
        call.getData().put("_retried", true);
        startPlayback(call);
    }

    private void startPlayback(PluginCall call) {
        JSArray items = call.getArray("items");
        if (items == null || items.length() == 0) {
            call.reject("items (playlist) required");
            return;
        }
        List<PassiveAudioService.Track> tracks = new ArrayList<>();
        try {
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.getJSONObject(i);
                String src = it.getString("src");
                String path = Uri.parse(src).getPath(); // file:// URI → filesystem path
                tracks.add(new PassiveAudioService.Track(
                        path,
                        it.optString("title", path),
                        it.getString("episodeId"),
                        it.optLong("startMs", 0)));
            }
        } catch (JSONException e) {
            call.reject("bad playlist item: " + e.getMessage());
            return;
        }
        int start = call.getInt("startIndex", 0);
        float speed = call.getFloat("speed", 1f);
        int startPositionMs = call.getInt("startPositionMs", 0);
        PassiveAudioService.pendingLoad =
                new PassiveAudioService.Load(tracks, start, speed, startPositionMs);
        Intent i = new Intent(getContext(), PassiveAudioService.class)
                .setAction(PassiveAudioService.ACTION_LOAD);
        ContextCompat.startForegroundService(getContext(), i);
        call.resolve();
    }

    private void withService(PluginCall call, java.util.function.Consumer<PassiveAudioService> fn) {
        PassiveAudioService s = PassiveAudioService.get();
        if (s == null) {
            call.resolve(); // nothing playing — controls are harmless no-ops
            return;
        }
        fn.accept(s);
        call.resolve();
    }

    @PluginMethod
    public void toggle(PluginCall call) {
        withService(call, PassiveAudioService::toggle);
    }

    @PluginMethod
    public void next(PluginCall call) {
        withService(call, PassiveAudioService::next);
    }

    @PluginMethod
    public void previous(PluginCall call) {
        withService(call, PassiveAudioService::previous);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        withService(call, PassiveAudioService::stopPlayback);
    }

    @PluginMethod
    public void setSpeed(PluginCall call) {
        float speed = call.getFloat("speed", 1f);
        withService(call, s -> s.setSpeed(speed));
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        int positionMs = call.getInt("positionMs", 0);
        withService(call, s -> s.seekTo(positionMs));
    }

    @PluginMethod
    public void seekBy(PluginCall call) {
        int deltaMs = call.getInt("deltaMs", 0);
        withService(call, s -> s.seekBy(deltaMs));
    }

    /** minutes > 0 arms (or re-arms) the sleep timer; 0 cancels it. */
    @PluginMethod
    public void setSleepTimer(PluginCall call) {
        int minutes = call.getInt("minutes", 0);
        withService(call, s -> s.setSleepTimer(minutes));
    }

    /** Mirror of the JS-side resume position into the service's store, so
        video watching and passive listening agree on "where you left off".
        positionMs <= 0 clears the entry. Works with the service dead. */
    @PluginMethod
    public void setSavedPosition(PluginCall call) {
        String episodeId = call.getString("episodeId");
        if (episodeId == null) {
            call.reject("episodeId required");
            return;
        }
        int positionMs = call.getInt("positionMs", 0);
        android.content.SharedPreferences prefs = getContext()
                .getSharedPreferences(PassiveAudioService.POSITIONS_PREFS,
                        android.content.Context.MODE_PRIVATE);
        if (positionMs > 0) prefs.edit().putLong(episodeId, positionMs).apply();
        else prefs.edit().remove(episodeId).apply();
        call.resolve();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(state());
    }
}
