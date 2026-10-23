package sh.xmatrix.app;

import android.net.Uri;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Pattern;

final class AppConfiguration {
  private static final int[] DEBUG_BRIDGE_PORTS = { 3000, 3001 };
  static final String APP_SCHEME = "xmatrix";
  private static final String STABLE_WEB_HOST = "xmatrix.sh";
  private static final String BETA_WEB_HOST = "beta.xmatrix.sh";
  /** A beta release's version, `X.Y.Z-beta.N`; a debug build of one adds `-debug` (build.gradle). */
  private static final Pattern BETA_VERSION =
    Pattern.compile("(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)-beta\\.[1-9]\\d*(-debug)?");
  /** The Web this build loads and trusts, by its own version. */
  static final String WEB_HOST = webHost(BuildConfig.VERSION_NAME);
  static final String START_URL = "https://" + WEB_HOST + "/app";
  static final String CLI_INSTALL_URL = "https://xmatrix.sh/api/cli/install";
  /** The one Hub that the beta and stable Webs both sign in through. */
  private static final String HUB_HOST = "xmatrix-hub.xmatrix.sh";

  private AppConfiguration() {}

  /**
   * The Web a build loads and trusts, by its own version: a beta
   * `X.Y.Z-beta.N` the beta Web, a stable `X.Y.Z` the stable one.
   */
  static String webHost(String versionName) {
    return versionName != null && BETA_VERSION.matcher(versionName).matches() ? BETA_WEB_HOST : STABLE_WEB_HOST;
  }

  /**
   * The hosts whose pages a build on `webHost` trusts: exactly that Web's, and
   * for the stable Web the `www` name it was always trusted under. Never the
   * other channel's Web or any other host under xmatrix.sh.
   */
  private static String[] trustedWebHosts(String webHost) {
    return STABLE_WEB_HOST.equals(webHost)
      ? new String[] { STABLE_WEB_HOST, "www." + STABLE_WEB_HOST }
      : new String[] { webHost };
  }

  private static boolean isTrustedWebHost(String webHost, String host) {
    for (String trusted : trustedWebHosts(webHost)) {
      if (trusted.equalsIgnoreCase(host)) {
        return true;
      }
    }
    return false;
  }

  static boolean isTrustedNavigation(Uri uri) {
    return uri != null && isTrustedNavigation(WEB_HOST, uri.getScheme(), uri.getHost(), BuildConfig.DEBUG);
  }

  static boolean isTrustedNavigation(String webHost, String scheme, String host, boolean debug) {
    if (scheme == null || host == null) {
      return false;
    }
    if ("https".equalsIgnoreCase(scheme) && isTrustedWebHost(webHost, host)) {
      return true;
    }
    return debug && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) && isLoopbackHost(host);
  }

  static boolean isTrustedBridgeOrigin(Uri uri) {
    if (uri == null) {
      return false;
    }
    return isTrustedBridgeOrigin(
      WEB_HOST,
      uri.getScheme(),
      uri.getHost(),
      uri.getPort(),
      BuildConfig.DEBUG
    );
  }

  static boolean isTrustedBridgeOrigin(
    String webHost,
    String scheme,
    String host,
    int port,
    boolean debug
  ) {
    if (scheme == null || host == null) {
      return false;
    }
    if ("https".equalsIgnoreCase(scheme) && isTrustedWebHost(webHost, host)) {
      return port == -1 || port == 443;
    }
    return debug
      && "http".equalsIgnoreCase(scheme)
      && isLoopbackHost(host)
      && isDebugBridgePort(port);
  }

  /** The origins this build's bridge answers. */
  static Set<String> trustedBridgeOriginRules() {
    return trustedBridgeOriginRules(WEB_HOST, BuildConfig.DEBUG);
  }

  static Set<String> trustedBridgeOriginRules(String webHost, boolean debug) {
    LinkedHashSet<String> origins = new LinkedHashSet<>();
    for (String host : trustedWebHosts(webHost)) {
      origins.add("https://" + host);
    }
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

  /** The address an in-place sign-in returns the app to, with its code. */
  static final String SIGN_IN_CALLBACK = "xmatrix://auth";

  static boolean isSignInCallback(Uri uri) {
    return uri != null && APP_SCHEME.equalsIgnoreCase(uri.getScheme()) && "auth".equalsIgnoreCase(uri.getHost());
  }

  /** The Hub's sign-in start page: the only page the app opens for an in-place sign-in. */
  static boolean isHubSignInStart(Uri uri) {
    return uri != null
      && isHubSignInStart(uri.getScheme(), uri.getHost(), uri.getPort(), uri.getUserInfo(), uri.getPath());
  }

  /** On exactly the Hub's https origin: neither Web nor any other host under xmatrix.sh. */
  static boolean isHubSignInStart(String scheme, String host, int port, String userInfo, String path) {
    return "https".equalsIgnoreCase(scheme)
      && HUB_HOST.equalsIgnoreCase(host)
      && (port == -1 || port == 443)
      && userInfo == null
      && "/api/auth/app/start".equals(path);
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
