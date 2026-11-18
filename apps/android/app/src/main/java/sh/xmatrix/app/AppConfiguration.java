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
  private static final Pattern LOGIN_ERROR = Pattern.compile("auth_error=[a-z0-9_]{1,64}");
  private static final Set<String> SIGN_IN_CALLBACK_PARAMS = Set.of("code", "state", "error", "new_account");
  private static final Pattern SIGN_IN_CALLBACK_VALUE = Pattern.compile("[A-Za-z0-9._~%+-]{1,2048}");

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
    return uri != null
      && isUnambiguousAddress(uri.toString())
      && isTrustedNavigation(WEB_HOST, uri.getScheme(), uri.getHost(), BuildConfig.DEBUG);
  }

  /**
   * Android's parser and the WebView's can disagree on the host of an address
   * with a backslash or user info (`https://evil.example\\@xmatrix.sh`).
   */
  static boolean isUnambiguousAddress(String address) {
    if (address == null || address.indexOf('\\') >= 0) {
      return false;
    }
    int start = address.indexOf("://");
    if (start < 0) {
      return false;
    }
    int end = start + 3;
    while (end < address.length() && "/?#".indexOf(address.charAt(end)) < 0) {
      end++;
    }
    return address.substring(start + 3, end).indexOf('@') < 0;
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
    return "https://" + WEB_HOST + deepLinkPath(uri.getHost(), uri.getPath(), uri.getEncodedQuery());
  }

  /**
   * Where an `xmatrix://` link lands. It is built only from values checked
   * here: whatever else a link carries came from another app and is dropped.
   */
  static String deepLinkPath(String host, String path, String query) {
    if ("channel".equalsIgnoreCase(host)) {
      String channelId = path == null ? "" : path.replaceFirst("^/", "");
      return PushMessaging.isConversationId(channelId) ? "/app?channel=" + channelId : "/app";
    }
    if ("login".equalsIgnoreCase(host)) {
      String authError = loginError(query);
      return authError == null ? "/login" : "/login?auth_error=" + authError;
    }
    return "/app";
  }

  private static String loginError(String query) {
    return query != null && LOGIN_ERROR.matcher(query).matches() ? query.substring("auth_error=".length()) : null;
  }

  /**
   * What the app's door passes on from another app, or null for a plain open.
   * A sign-in return and the bare login return stay `xmatrix://` links, which
   * the page's activity answers without navigating; the rest become its Web.
   */
  static String entryLink(String webHost, String scheme, String host, String path, String query) {
    if (!APP_SCHEME.equalsIgnoreCase(scheme) || host == null) {
      return null;
    }
    if ("auth".equalsIgnoreCase(host)) {
      String callback = signInCallbackQuery(query);
      return callback == null ? null : SIGN_IN_CALLBACK + "?" + callback;
    }
    if ("login".equalsIgnoreCase(host)) {
      return loginError(query) == null ? "xmatrix://login" : "https://" + webHost + deepLinkPath(host, path, query);
    }
    String target = deepLinkPath(host, path, query);
    return target.equals("/app") ? null : "https://" + webHost + target;
  }

  /** Only what the Hub's sign-in return carries, each once; without its state it is no return. */
  static String signInCallbackQuery(String query) {
    if (query == null) {
      return null;
    }
    LinkedHashSet<String> names = new LinkedHashSet<>();
    StringBuilder kept = new StringBuilder();
    for (String pair : query.split("&")) {
      int equals = pair.indexOf('=');
      String name = equals < 0 ? pair : pair.substring(0, equals);
      if (!SIGN_IN_CALLBACK_PARAMS.contains(name)) continue;
      String value = equals < 0 ? "" : pair.substring(equals + 1);
      if (!names.add(name) || !SIGN_IN_CALLBACK_VALUE.matcher(value).matches()) {
        return null;
      }
      kept.append(kept.length() == 0 ? "" : "&").append(name).append('=').append(value);
    }
    return names.contains("state") ? kept.toString() : null;
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
