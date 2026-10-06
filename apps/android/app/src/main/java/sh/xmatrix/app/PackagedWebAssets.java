package sh.xmatrix.app;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import androidx.webkit.WebViewAssetLoader;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

final class PackagedWebAssets implements WebViewAssetLoader.PathHandler {
  private static final String ASSET_ROOT = "xmatrix-web";
  private static final Map<String, String> MIME_TYPES = new HashMap<>();

  static {
    MIME_TYPES.put("css", "text/css");
    MIME_TYPES.put("gif", "image/gif");
    MIME_TYPES.put("html", "text/html");
    MIME_TYPES.put("ico", "image/x-icon");
    MIME_TYPES.put("jpg", "image/jpeg");
    MIME_TYPES.put("jpeg", "image/jpeg");
    MIME_TYPES.put("js", "application/javascript");
    MIME_TYPES.put("json", "application/json");
    MIME_TYPES.put("map", "application/json");
    MIME_TYPES.put("png", "image/png");
    MIME_TYPES.put("svg", "image/svg+xml");
    MIME_TYPES.put("txt", "text/plain");
    MIME_TYPES.put("webmanifest", "application/manifest+json");
    MIME_TYPES.put("webp", "image/webp");
    MIME_TYPES.put("woff2", "font/woff2");
    MIME_TYPES.put("xml", "application/xml");
  }

  private final Context context;

  PackagedWebAssets(Context context) {
    this.context = context.getApplicationContext();
  }

  @Override
  public WebResourceResponse handle(String path) {
    String assetPath = assetPathFor(Uri.decode(path == null ? "" : path));
    if (assetPath == null) {
      return null;
    }

    try {
      InputStream stream = context.getAssets().open(ASSET_ROOT + "/" + assetPath);
      return new WebResourceResponse(mimeType(assetPath), charset(assetPath), stream);
    } catch (IOException ignored) {
      return null;
    }
  }

  private static String assetPathFor(String rawPath) {
    String path = rawPath == null || rawPath.isEmpty() ? "/" : rawPath;
    if (!path.startsWith("/")) {
      path = "/" + path;
    }

    if (path.startsWith("/api/") || path.startsWith("/auth/callback")) {
      return null;
    }
    if (path.equals("/") || path.equals("/index.html")) {
      return "index.html";
    }
    if (path.equals("/app") || path.equals("/app/") || path.startsWith("/app/")) {
      return "app.html";
    }
    if (path.equals("/login") || path.equals("/login/")) {
      return "login.html";
    }
    if (path.equals("/docs") || path.equals("/docs/")) {
      return "docs.html";
    }
    if (path.equals("/download") || path.equals("/download/")) {
      return "download.html";
    }
    if (path.equals("/console") || path.equals("/console/")) {
      return "console.html";
    }
    if (path.startsWith("/_next/static/")) {
      return "next/static/" + path.substring("/_next/static/".length());
    }

    String normalized = path.substring(1);
    if (normalized.contains("..")) {
      return null;
    }
    return normalized;
  }

  private static String mimeType(String assetPath) {
    int dot = assetPath.lastIndexOf('.');
    if (dot < 0 || dot == assetPath.length() - 1) {
      return "application/octet-stream";
    }
    return MIME_TYPES.getOrDefault(assetPath.substring(dot + 1).toLowerCase(), "application/octet-stream");
  }

  private static String charset(String assetPath) {
    String mimeType = mimeType(assetPath);
    return mimeType.startsWith("text/") || "application/javascript".equals(mimeType) || "application/json".equals(mimeType)
      ? "UTF-8"
      : null;
  }
}
