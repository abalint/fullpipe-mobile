package app.fullpipe.mobile;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Hands a downloaded episode to an external video player (VLC). The video
 * lives in app-internal storage, so it goes out as a content:// URI through
 * the FileProvider with a read grant. The subtitle sidecar rides along via
 * VLC's "subtitles_location" extra (best-effort — other players ignore it).
 */
@CapacitorPlugin(name = "ExternalPlayer")
public class ExternalPlayerPlugin extends Plugin {

    private Uri contentUri(String fileUrl) {
        File f = new File(Uri.parse(fileUrl).getPath());
        return FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", f);
    }

    @PluginMethod
    public void play(PluginCall call) {
        String video = call.getString("video");
        if (video == null) {
            call.reject("video (file:// url) required");
            return;
        }
        try {
            Uri videoUri = contentUri(video);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(videoUri, "video/mp4");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);

            String title = call.getString("title");
            if (title != null) i.putExtra("title", title);

            String subs = call.getString("subs");
            if (subs != null) {
                Uri subsUri = contentUri(subs);
                i.putExtra("subtitles_location", subsUri.toString());
                // grant covers both URIs
                ClipData clip = ClipData.newRawUri("video", videoUri);
                clip.addItem(new ClipData.Item(subsUri));
                i.setClipData(clip);
            }
            getActivity().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no video player app installed");
        } catch (IllegalArgumentException e) {
            call.reject("file not shareable: " + e.getMessage());
        }
    }
}
