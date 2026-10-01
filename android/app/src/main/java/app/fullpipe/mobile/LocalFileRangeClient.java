package app.fullpipe.mobile;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Serves Range requests for convertFileSrc() URLs (/_capacitor_file_/...)
 * with 64-bit offsets. Capacitor's own handler sizes the file with
 * InputStream.available() — an int — and parses the range end with
 * Integer.parseInt, so any file over 2 GiB (a 3-hour baseball broadcast at
 * 480p) gets a garbage Content-Range and the <video> element refuses it.
 * Everything that isn't a ranged local-file GET falls through to Capacitor.
 *
 * The body stream starts at byte 0 on purpose: the WebView itself skip()s to
 * the range start in any intercepted stream (Chromium's InputStreamReader),
 * so a pre-positioned stream gets offset twice. It also bounds-checks the
 * range against available() — an int — so available() reports 0, which
 * Chromium reads as "size unknown" and skips the check.
 */
public class LocalFileRangeClient extends BridgeWebViewClient {

    public LocalFileRangeClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        String path = request.getUrl().getPath();
        String range = header(request, "Range");
        if (path != null && path.startsWith(Bridge.CAPACITOR_FILE_START) && range != null
                && "GET".equalsIgnoreCase(request.getMethod())) {
            WebResourceResponse r = serveRange(path.substring(Bridge.CAPACITOR_FILE_START.length()), range);
            if (r != null) return r;
        }
        return super.shouldInterceptRequest(view, request);
    }

    private static String header(WebResourceRequest request, String name) {
        for (Map.Entry<String, String> e : request.getRequestHeaders().entrySet()) {
            if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }

    /** null = not something we handle (malformed / multi-range / missing file) — let Capacitor try. */
    private static WebResourceResponse serveRange(String filePath, String rangeHeader) {
        File f = new File(filePath);
        if (!f.isFile()) return null;
        long size = f.length();
        String spec = rangeHeader.trim();
        if (!spec.startsWith("bytes=") || spec.contains(",")) return null;
        spec = spec.substring("bytes=".length()).trim();
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
        long start;
        long end;
        try {
            String a = spec.substring(0, dash).trim();
            String b = spec.substring(dash + 1).trim();
            if (a.isEmpty()) {
                // suffix range: the last N bytes
                long n = Long.parseLong(b);
                start = Math.max(0, size - n);
                end = size - 1;
            } else {
                start = Long.parseLong(a);
                end = b.isEmpty() ? size - 1 : Math.min(Long.parseLong(b), size - 1);
            }
        } catch (NumberFormatException e) {
            return null;
        }

        String mime = mimeFor(filePath);
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "no-cache");
        if (start >= size || start > end) {
            headers.put("Content-Range", "bytes */" + size);
            return new WebResourceResponse(mime, null, 416, "Range Not Satisfiable", headers, null);
        }
        long length = end - start + 1;
        InputStream in;
        try {
            in = new FileRangeStream(new FileInputStream(f), end + 1);
        } catch (IOException e) {
            return null;
        }
        headers.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
        headers.put("Content-Length", Long.toString(length));
        return new WebResourceResponse(mime, null, 206, "Partial Content", headers, in);
    }

    private static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".mp4") || p.endsWith(".m4v")) return "video/mp4";
        if (p.endsWith(".webm")) return "video/webm";
        if (p.endsWith(".m4a")) return "audio/mp4";
        if (p.endsWith(".mp3")) return "audio/mpeg";
        if (p.endsWith(".opus") || p.endsWith(".ogg")) return "audio/ogg";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".webp")) return "image/webp";
        return "application/octet-stream";
    }

    /** Whole-file stream with a 64-bit seek for the WebView's skip(), ending
        at `limit` (exclusive) so a bounded range doesn't stream to EOF. */
    private static final class FileRangeStream extends InputStream {
        private final FileInputStream in;
        private final long limit;
        private long pos = 0;

        FileRangeStream(FileInputStream in, long limit) {
            this.in = in;
            this.limit = limit;
        }

        @Override
        public long skip(long n) throws IOException {
            if (n <= 0) return 0;
            long to = Math.min(limit, pos + n);
            in.getChannel().position(to);
            long skipped = to - pos;
            pos = to;
            return skipped;
        }

        @Override
        public int read() throws IOException {
            if (pos >= limit) return -1;
            int b = in.read();
            if (b >= 0) pos++;
            return b;
        }

        @Override
        public int read(byte[] buf, int off, int len) throws IOException {
            if (pos >= limit) return -1;
            int n = in.read(buf, off, (int) Math.min(len, limit - pos));
            if (n > 0) pos += n;
            return n;
        }

        @Override
        public int available() {
            return 0;
        }

        @Override
        public void close() throws IOException {
            in.close();
        }
    }
}
