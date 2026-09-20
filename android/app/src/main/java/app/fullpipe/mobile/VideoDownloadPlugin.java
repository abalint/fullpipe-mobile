package app.fullpipe.mobile;

import android.content.Intent;
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
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * JS bridge for VideoDownloadService. enqueue() hands an episode's file list
 * to the foreground queue; "progress"/"done" events stream back while the
 * webview is alive, and getState() + ack() let it catch up on anything that
 * finished while it wasn't (downloads.ts reconcile).
 */
@CapacitorPlugin(
        name = "VideoDownload",
        permissions = @Permission(
                strings = {"android.permission.POST_NOTIFICATIONS"},
                alias = "notifications"))
public class VideoDownloadPlugin extends Plugin {

    @Override
    public void load() {
        VideoDownloadService.listener = new VideoDownloadService.Listener() {
            @Override
            public void onProgress(String episodeId, long bytes, long total, String phase) {
                JSObject o = new JSObject();
                o.put("episodeId", episodeId);
                o.put("bytes", bytes);
                o.put("total", total);
                o.put("phase", phase);
                notifyListeners("progress", o);
            }

            @Override
            public void onDone(String episodeId, JSONObject result) {
                try {
                    notifyListeners("done", new JSObject(result.toString()));
                } catch (JSONException ignored) {
                }
            }
        };
    }

    @PluginMethod
    public void enqueue(PluginCall call) {
        // the progress notification needs POST_NOTIFICATIONS on 13+; the
        // service runs either way, so ask once and go on regardless
        if (Build.VERSION.SDK_INT >= 33
                && getPermissionState("notifications") != PermissionState.GRANTED
                && !call.getBoolean("_retried", false)) {
            requestPermissionForAlias("notifications", call, "notifPermDone");
            return;
        }
        doEnqueue(call);
    }

    @PermissionCallback
    private void notifPermDone(PluginCall call) {
        call.getData().put("_retried", true);
        doEnqueue(call);
    }

    private void doEnqueue(PluginCall call) {
        String episodeId = call.getString("episodeId");
        JSArray files = call.getArray("files");
        if (episodeId == null || files == null || files.length() == 0) {
            call.reject("episodeId and files required");
            return;
        }
        List<VideoDownloadService.FileSpec> specs = new ArrayList<>();
        Map<String, String> headers = new HashMap<>();
        try {
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                specs.add(new VideoDownloadService.FileSpec(
                        f.getString("url"), f.getString("path"), f.optBoolean("required", false)));
            }
            JSObject h = call.getObject("headers");
            if (h != null) {
                Iterator<String> keys = h.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    headers.put(k, h.getString(k));
                }
            }
        } catch (JSONException e) {
            call.reject("bad file spec: " + e.getMessage());
            return;
        }
        String title = call.getString("title", episodeId);
        boolean added = VideoDownloadService.offer(
                new VideoDownloadService.Job(episodeId, title, specs, headers));
        if (added) {
            Intent i = new Intent(getContext(), VideoDownloadService.class)
                    .setAction(VideoDownloadService.ACTION_ENQUEUE);
            ContextCompat.startForegroundService(getContext(), i);
        }
        JSObject o = new JSObject();
        o.put("queued", added);
        call.resolve(o);
    }

    /** In-flight + waiting episodes, and finished results the JS side hasn't
        acked yet (they survive a webview reload / process death). */
    @PluginMethod
    public void getState(PluginCall call) {
        JSObject o = new JSObject();
        try {
            JSArray active = new JSArray();
            for (JSONObject a : VideoDownloadService.activeSnapshot()) active.put(new JSObject(a.toString()));
            JSArray results = new JSArray();
            for (JSONObject r : VideoDownloadService.pendingResults(getContext()))
                results.put(new JSObject(r.toString()));
            o.put("active", active);
            o.put("results", results);
        } catch (JSONException e) {
            call.reject("state: " + e.getMessage());
            return;
        }
        call.resolve(o);
    }

    @PluginMethod
    public void ack(PluginCall call) {
        JSArray ids = call.getArray("episodeIds");
        List<String> list = new ArrayList<>();
        try {
            if (ids != null) for (int i = 0; i < ids.length(); i++) list.add(ids.getString(i));
        } catch (JSONException e) {
            call.reject("bad ids: " + e.getMessage());
            return;
        }
        VideoDownloadService.ack(getContext(), list);
        call.resolve();
    }
}
