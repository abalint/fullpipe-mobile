// JS side of the native ShareTarget plugin. Silently inert on plain web (dev
// in a browser) where the native implementation doesn't exist.

import { registerPlugin } from "@capacitor/core";

interface ShareTargetPlugin {
  getPendingShare(): Promise<{ text?: string | null }>;
  addListener(
    event: "share",
    cb: (data: { text: string }) => void,
  ): Promise<unknown>;
}

const ShareTarget = registerPlugin<ShareTargetPlugin>("ShareTarget");

/** YouTube shares arrive as "title https://youtu.be/…" — pull out the URL. */
function extractUrl(text: string): string {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : text.trim();
}

export function installShareTarget(onUrl: (url: string) => void): void {
  const handle = (text?: string | null) => {
    if (text) onUrl(extractUrl(text));
  };
  void ShareTarget.addListener("share", (d) => handle(d.text)).catch(() => {});
  void ShareTarget.getPendingShare()
    .then((d) => handle(d.text))
    .catch(() => {});
}
