import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.fullpipe.mobile",
  appName: "fullPipe",
  webDir: "dist",
  android: {
    // webview origin is https://localhost; the tailnet server is plain http —
    // without this the fetch dies as mixed content even with the cleartext
    // exception (network_security_config.xml) in place
    allowMixedContent: true,
  },
};

export default config;
