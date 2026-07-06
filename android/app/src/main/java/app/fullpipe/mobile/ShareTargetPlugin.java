package app.fullpipe.mobile;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android share-sheet target (MOBILE.md "Bidirectional initiation"): share a
 * YouTube link straight into the app and it lands in the queue screen.
 *
 * Cold start: the launching intent is captured in load(); JS pulls it with
 * getPendingShare() on startup. Warm start (app already running): a "share"
 * event is fired at the webview.
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    private String pending;

    @Override
    public void load() {
        capture(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        capture(intent);
        if (pending != null) {
            JSObject data = new JSObject();
            data.put("text", pending);
            pending = null;
            notifyListeners("share", data);
        }
    }

    private void capture(Intent intent) {
        if (intent != null
                && Intent.ACTION_SEND.equals(intent.getAction())
                && "text/plain".equals(intent.getType())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null) pending = text;
        }
    }

    @PluginMethod
    public void getPendingShare(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("text", pending);
        pending = null;
        call.resolve(ret);
    }
}
