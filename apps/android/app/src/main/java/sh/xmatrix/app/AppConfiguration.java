package sh.xmatrix.app;

import android.net.Uri;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

final class AppConfiguration {
  private static final int[] DEBUG_BRIDGE_PORTS = { 3000, 3001 };
  static final String APP_SCHEME = "xmatrix";
  static final String WEB_HOST = "xmatrix.sh";
  static final String TEST_WEB_HOST = "test.xmatrix.sh";
  static final String START_URL = "https://xmatrix.sh/app";
  static final String CLI_INSTALL_URL = "https://xmatrix.sh/api/cli/install";

  private AppConfiguration() {}

  static boolean isTrustedNavigation(Uri uri) {
    String scheme = uri.getScheme();
    String host = uri.getHost();
    if (scheme == null || host == null) {
      return false;
    }
    if ("https".equalsIgnoreCase(scheme) && isXMatrixHost(host)) {
      return true;
    }
    return BuildConfig.DEBUG && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
      && ("localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host) || "::1".equals(host));
  }

  static boolean isTrustedBridgeOrigin(Uri uri) {
    if (uri == null) {
      return false;
    }
    return isTrustedBridgeOrigin(
      uri.getScheme(),
      uri.getHost(),
      uri.getPort(),
      BuildConfig.DEBUG
    );
  }

  static boolean isTrustedBridgeOrigin(
    String scheme,
    String host,
    int port,
    boolean debug
  ) {
    if (scheme == null || host == null) {
      return false;
    }
    if ("https".equalsIgnoreCase(scheme) && isXMatrixHost(host)) {
      return port == -1 || port == 443;
    }
    return debug
      && "http".equalsIgnoreCase(scheme)
      && isLoopbackHost(host)
      && isDebugBridgePort(port);
  }

  static Set<String> trustedBridgeOriginRules(boolean debug) {
    LinkedHashSet<String> origins = new LinkedHashSet<>();
    origins.add("https://xmatrix.sh");
    origins.add("https://www.xmatrix.sh");
    origins.add("https://test.xmatrix.sh");
    if (debug) {
      for (int port : DEBUG_BRIDGE_PORTS) {
        origins.add("http://localhost:" + port);
        origins.add("http://127.0.0.1:" + port);
        origins.add("http://[::1]:" + port);
      }
    }
    return Collections.unmodifiableSet(origins);
  }

  static boolean isSafeExternalUrl(Uri uri) {
    String scheme = uri == null ? null : uri.getScheme();
    return "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme) || "mailto".equalsIgnoreCase(scheme);
  }

  private static boolean isXMatrixHost(String host) {
    return WEB_HOST.equalsIgnoreCase(host)
      || "www.xmatrix.sh".equalsIgnoreCase(host)
      || TEST_WEB_HOST.equalsIgnoreCase(host);
  }

  private static boolean isLoopbackHost(String host) {
    return "localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host) || "::1".equals(host);
  }

  private static boolean isDebugBridgePort(int port) {
    for (int allowedPort : DEBUG_BRIDGE_PORTS) {
      if (port == allowedPort) {
        return true;
      }
    }
    return false;
  }

  static String mapDeepLink(Uri uri) {
    if (!APP_SCHEME.equalsIgnoreCase(uri.getScheme())) {
      return uri.toString();
    }

    String host = uri.getHost() == null ? "" : uri.getHost();
    String path = uri.getPath() == null ? "" : uri.getPath();
    String query = uri.getEncodedQuery();

    String mappedPath;
    if ("channel".equals(host)) {
      String channelId = path.startsWith("/") ? path.substring(1) : path;
      Uri.Builder builder = Uri.parse(START_URL).buildUpon().path("/app");
      if (!channelId.isEmpty()) {
        builder.appendQueryParameter("channel", channelId);
      }
      if (query != null && !query.isEmpty()) {
        builder.encodedQuery(builder.build().getEncodedQuery() == null
          ? query
          : builder.build().getEncodedQuery() + "&" + query);
      }
      return builder.build().toString();
    } else if ("login".equals(host)) {
      mappedPath = "/login";
    } else {
      mappedPath = "/app";
    }

    Uri.Builder builder = Uri.parse(START_URL).buildUpon().path(mappedPath);
    if (query != null && !query.isEmpty()) {
      builder.encodedQuery(query);
    }
    return builder.build().toString();
  }

  static boolean isNativeLoginResume(Uri uri) {
    return uri != null && isNativeLoginResume(
      uri.getScheme(),
      uri.getHost(),
      uri.getEncodedQuery()
    );
  }

  static boolean isNativeLoginResume(String scheme, String host, String query) {
    return APP_SCHEME.equalsIgnoreCase(scheme)
      && "login".equalsIgnoreCase(host)
      && (query == null || query.isEmpty());
  }
}
