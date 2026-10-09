package app.fullpipe.mobile;

import android.net.Uri;
import android.os.Build;

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
 * JS bridge for AmbienceService: layers (looping sounds) and the music
 * channel, each with a volume, plus pause/resume/stop and the voice-clip
 * duck. Every call that can start sound goes through AmbienceService.run,
 * which starts the foreground service on demand; state streams back as
 * "state" events.
 */
@CapacitorPlugin(
        name = "Ambience",
        permissions = @Permission(
                strings = {"android.permission.POST_NOTIFICATIONS"},
                alias = "notifications"))
public class AmbiencePlugin extends Plugin {

    @Override
    public void load() {
        AmbienceService.stateListener = () -> notifyListeners("state", state());
    }

    private JSObject state() {
        AmbienceService s = AmbienceService.get();
        JSObject o = new JSObject();
        boolean running = s != null && s.isRunning();
        o.put("running", running);
        o.put("paused", s != null && s.isPaused());
        JSArray layers = new JSArray();
        if (s != null) {
            for (String id : s.layerIds()) {
                JSObject l = new JSObject();
                l.put("id", id);
                l.put("volume", s.layerVolume(id));
                layers.put(l);
            }
        }
        o.put("layers", layers);
        if (s != null && s.hasMusic()) {
            JSObject m = new JSObject();
            m.put("mood", s.moodTitle());
            m.put("title", s.musicTitle());
            m.put("src", s.musicPath());
            m.put("count", s.trackCount());
            m.put("volume", s.musicVolume());
            o.put("music", m);
        }
        return o;
    }

    private static String pathOf(String src) {
        String p = Uri.parse(src).getPath(); // file:// URI → filesystem path
        return p != null ? p : src;
    }

    private boolean needsNotifPermission(PluginCall call, String cb) {
        if (Build.VERSION.SDK_INT >= 33
                && getPermissionState("notifications") != PermissionState.GRANTED
                && !call.getBoolean("_retried", false)) {
            requestPermissionForAlias("notifications", call, cb);
            return true;
        }
        return false;
    }

    @PluginMethod
    public void setLayer(PluginCall call) {
        if (needsNotifPermission(call, "layerPermDone")) return;
        doSetLayer(call);
    }

    @PermissionCallback
    private void layerPermDone(PluginCall call) {
        call.getData().put("_retried", true);
        doSetLayer(call);
    }

    private void doSetLayer(PluginCall call) {
        String id = call.getString("id");
        String src = call.getString("src");
        if (id == null || src == null) {
            call.reject("id and src required");
            return;
        }
        String title = call.getString("title", id);
        float volume = call.getFloat("volume", 0.5f);
        AmbienceService.run(getContext(), s -> s.setLayer(id, pathOf(src), title, volume));
        call.resolve();
    }

    @PluginMethod
    public void setMusic(PluginCall call) {
        if (needsNotifPermission(call, "musicPermDone")) return;
        doSetMusic(call);
    }

    @PermissionCallback
    private void musicPermDone(PluginCall call) {
        call.getData().put("_retried", true);
        doSetMusic(call);
    }

    private void doSetMusic(PluginCall call) {
        JSArray items = call.getArray("tracks");
        if (items == null || items.length() == 0) {
            call.reject("tracks required");
            return;
        }
        List<AmbienceService.Track> tracks = new ArrayList<>();
        try {
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.getJSONObject(i);
                String src = it.getString("src");
                tracks.add(new AmbienceService.Track(pathOf(src), it.optString("title", src)));
            }
        } catch (JSONException e) {
            call.reject("bad track: " + e.getMessage());
            return;
        }
        String title = call.getString("title", "music");
        float volume = call.getFloat("volume", 0.6f);
        boolean keep = call.getBoolean("keep", true);
        AmbienceService.run(getContext(), s -> s.setMusic(tracks, title, volume, keep));
        call.resolve();
    }

    private void withService(PluginCall call, java.util.function.Consumer<AmbienceService> fn) {
        AmbienceService s = AmbienceService.get();
        if (s == null) {
            call.resolve(); // nothing playing — a no-op
            return;
        }
        fn.accept(s);
        call.resolve();
    }

    @PluginMethod
    public void removeLayer(PluginCall call) {
        String id = call.getString("id");
        withService(call, s -> s.removeLayer(id));
    }

    @PluginMethod
    public void setLayerVolume(PluginCall call) {
        String id = call.getString("id");
        float volume = call.getFloat("volume", 0.5f);
        withService(call, s -> s.setLayerVolume(id, volume));
    }

    @PluginMethod
    public void stopMusic(PluginCall call) {
        withService(call, AmbienceService::stopMusic);
    }

    @PluginMethod
    public void nextTrack(PluginCall call) {
        withService(call, AmbienceService::nextTrack);
    }

    @PluginMethod
    public void previousTrack(PluginCall call) {
        withService(call, AmbienceService::previousTrack);
    }

    @PluginMethod
    public void setMusicVolume(PluginCall call) {
        float volume = call.getFloat("volume", 0.6f);
        withService(call, s -> s.setMusicVolume(volume));
    }

    @PluginMethod
    public void pause(PluginCall call) {
        withService(call, AmbienceService::pause);
    }

    @PluginMethod
    public void resume(PluginCall call) {
        withService(call, AmbienceService::resume);
    }

    @PluginMethod
    public void stopAll(PluginCall call) {
        withService(call, AmbienceService::stopAll);
    }

    @PluginMethod
    public void setDuck(PluginCall call) {
        boolean on = call.getBoolean("on", false);
        withService(call, s -> s.setDuck(on));
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(state());
    }
}
