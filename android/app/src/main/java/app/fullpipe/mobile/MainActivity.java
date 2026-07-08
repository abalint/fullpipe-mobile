package app.fullpipe.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareTargetPlugin.class);
        registerPlugin(PassiveAudioPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
