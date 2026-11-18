package sh.xmatrix.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Set;
import org.junit.Test;

public final class AppConfigurationTest {
  private static final String STABLE = AppConfiguration.webHost("1.2.0");
  private static final String BETA = AppConfiguration.webHost("1.2.0-beta.3");

  @Test
  public void aBuildsVersionPicksTheWebItLoads() {
    assertEquals("xmatrix.sh", STABLE);
    assertEquals("beta.xmatrix.sh", BETA);
    assertEquals(BETA, AppConfiguration.webHost("1.2.0-beta.3-debug"));
    for (String version : new String[] { "1.2.0-debug", "1.2.0-rc.1", "1.2.0-beta.0", "", null }) {
      assertEquals(String.valueOf(version), STABLE, AppConfiguration.webHost(version));
    }
  }

  @Test
  public void productionBridgeOriginsAreExactAndHttpsOnly() {
    assertEquals(Set.of("https://xmatrix.sh", "https://www.xmatrix.sh"), AppConfiguration.trustedBridgeOriginRules(STABLE, false));
    assertEquals(Set.of("https://beta.xmatrix.sh"), AppConfiguration.trustedBridgeOriginRules(BETA, false));
    assertTrue(AppConfiguration.isTrustedBridgeOrigin(STABLE, "https", "xmatrix.sh", -1, false));
    assertTrue(AppConfiguration.isTrustedBridgeOrigin(STABLE, "https", "www.xmatrix.sh", 443, false));
    assertTrue(AppConfiguration.isTrustedBridgeOrigin(BETA, "https", "beta.xmatrix.sh", 443, false));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin(STABLE, "https", "test.xmatrix.sh", 443, false));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin(STABLE, "http", "xmatrix.sh", -1, false));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin(STABLE, "https", "xmatrix.sh", 8443, false));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin(STABLE, "https", "auth.xmatrix.sh", -1, false));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin(BETA, "http", "beta.xmatrix.sh", -1, false));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin(BETA, "https", "beta.xmatrix.sh", 8443, false));
  }

  @Test
  public void aBuildTrustsOnlyItsOwnChannelsWeb() {
    assertTrue(AppConfiguration.isTrustedNavigation(STABLE, "https", "www.xmatrix.sh", false));
    // The other channel's Web, the Hub, siblings and lookalikes, for navigation and the bridge alike.
    String[][] refused = {
      { STABLE, "beta.xmatrix.sh" }, { STABLE, "xmatrix-hub.xmatrix.sh" }, { STABLE, "xmatrix.sh.evil.example" },
      { BETA, "xmatrix.sh" }, { BETA, "www.xmatrix.sh" }, { BETA, "www.beta.xmatrix.sh" },
      { BETA, "xmatrix-hub.xmatrix.sh" }, { BETA, "beta.xmatrix.sh.evil.example" }, { BETA, "evilbeta.xmatrix.sh" },
    };
    for (String[] build : refused) {
      String web = build[0];
      String host = build[1];
      assertTrue(web, AppConfiguration.isTrustedNavigation(web, "https", web, false));
      assertFalse(web + " " + host, AppConfiguration.isTrustedNavigation(web, "https", host, false));
      assertFalse(web + " " + host, AppConfiguration.isTrustedBridgeOrigin(web, "https", host, -1, false));
    }
    assertFalse(AppConfiguration.isTrustedNavigation(BETA, "http", "beta.xmatrix.sh", false));
  }

  @Test
  public void debugBridgeOriginsAllowOnlyLoopbackDevelopmentHosts() {
    Set<String> rules = AppConfiguration.trustedBridgeOriginRules(STABLE, true);

    assertTrue(rules.contains("http://localhost:3001"));
    assertTrue(rules.contains("http://127.0.0.1:3000"));
    assertTrue(rules.contains("http://[::1]:3001"));
    assertFalse(rules.stream().anyMatch((rule) -> rule.contains(":*")));
    assertTrue(AppConfiguration.isTrustedBridgeOrigin(STABLE, "http", "localhost", 3000, true));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin(STABLE, "http", "localhost", 4611, true));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin(STABLE, "https", "localhost", 3001, true));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin(STABLE, "http", "192.168.1.2", 3000, true));
  }

  @Test
  public void inPlaceSignInOpensOnlyTheHubSignInStartPage() {
    String start = "/api/auth/app/start";
    assertTrue(AppConfiguration.isHubSignInStart("https", "xmatrix-hub.xmatrix.sh", -1, null, start));
    assertTrue(AppConfiguration.isHubSignInStart("https", "xmatrix-hub.xmatrix.sh", 443, null, start));
    assertFalse(AppConfiguration.isHubSignInStart("http", "xmatrix-hub.xmatrix.sh", -1, null, start));
    assertFalse(AppConfiguration.isHubSignInStart("https", "evil.example", -1, null, start));
    assertFalse(AppConfiguration.isHubSignInStart("https", "xmatrix.sh.evil.example", -1, null, start));
    assertFalse(AppConfiguration.isHubSignInStart("https", "xmatrix-hub.xmatrix.sh", -1, "user", start));
    assertFalse(AppConfiguration.isHubSignInStart("https", "xmatrix-hub.xmatrix.sh", -1, null, "/login"));
    assertFalse(AppConfiguration.isHubSignInStart("https", "xmatrix-hub.xmatrix.sh", 8443, null, start));
    // The Hub itself only: neither Web nor any other host under xmatrix.sh.
    for (String host : new String[] { "xmatrix.sh", "beta.xmatrix.sh", "other.xmatrix.sh" }) {
      assertFalse(host, AppConfiguration.isHubSignInStart("https", host, -1, null, start));
    }
  }

  @Test
  public void bareNativeLoginReturnOnlyResumesTheExistingWebView() {
    assertTrue(AppConfiguration.isNativeLoginResume("xmatrix", "login", null));
    assertTrue(AppConfiguration.isNativeLoginResume("XMATRIX", "LOGIN", ""));
    assertFalse(AppConfiguration.isNativeLoginResume("https", "login", null));
    assertFalse(AppConfiguration.isNativeLoginResume("xmatrix", "channel", null));
    assertFalse(AppConfiguration.isNativeLoginResume("xmatrix", "login", "auth_error=denied"));
  }

  @Test
  public void anotherAppsLinkReachesThePageOnlyAsACheckedAddress() {
    String web = "xmatrix.sh";
    assertEquals("https://xmatrix.sh/app?channel=channel:personal_1",
      AppConfiguration.entryLink(web, "xmatrix", "channel", "/channel:personal_1", null));
    assertEquals("https://xmatrix.sh/app?channel=abc",
      AppConfiguration.entryLink(web, "xmatrix", "channel", "/abc", "next=https://evil.example"));
    assertEquals("xmatrix://login", AppConfiguration.entryLink(web, "xmatrix", "login", null, null));
    assertEquals("https://xmatrix.sh/login?auth_error=denied",
      AppConfiguration.entryLink(web, "xmatrix", "login", null, "auth_error=denied"));
    // The device approval screen cannot be opened with another app's code.
    assertEquals("xmatrix://login",
      AppConfiguration.entryLink(web, "xmatrix", "login", null, "device_code=d&user_code=ATTACKER"));
    assertEquals("xmatrix://login",
      AppConfiguration.entryLink(web, "xmatrix", "login", null, "cli_callback=http://evil.example"));

    String[][] plainOpens = {
      { "https", "xmatrix.sh", "/app", null },
      { "https", "evil.example", "/", null },
      { "javascript", null, null, null },
      { "file", "", "/data/data/sh.xmatrix.app/app_webview/Default/Cookies", null },
      { "xmatrix", "channel", "/../../login", null },
      { "xmatrix", "channel", "/a'+alert(1)+'", null },
      { "xmatrix", "channel", "", null },
      { "xmatrix", "connect", "/oauth", "state=s&code=c" },
      { "xmatrix", "other", "/", "next=https://evil.example" },
    };
    for (String[] link : plainOpens) {
      assertEquals(String.join(" ", String.valueOf(link[0]), String.valueOf(link[1]), String.valueOf(link[2])),
        null, AppConfiguration.entryLink(web, link[0], link[1], link[2], link[3]));
    }
  }

  @Test
  public void aSignInReturnKeepsOnlyWhatTheHubSends() {
    assertEquals("xmatrix://auth?code=c0de&new_account=1&state=s-1",
      AppConfiguration.entryLink("xmatrix.sh", "xmatrix", "auth", null, "code=c0de&new_account=1&state=s-1"));
    assertEquals("error=sign_in_required&state=s", AppConfiguration.signInCallbackQuery("error=sign_in_required&state=s"));
    assertEquals("code=c&state=s", AppConfiguration.signInCallbackQuery("code=c&next=https://evil.example&state=s"));
    for (String refused : new String[] { null, "", "code=c", "state=a&state=b", "code=c&state=a'b", "code=&state=s" }) {
      assertEquals(String.valueOf(refused), null, AppConfiguration.signInCallbackQuery(refused));
    }
  }

  @Test
  public void anAddressWhoseHostParsersCouldReadDifferentlyIsRefused() {
    assertTrue(AppConfiguration.isUnambiguousAddress("https://xmatrix.sh/app?next=a@b.example#c@d"));
    assertFalse(AppConfiguration.isUnambiguousAddress("https://evil.example\\@xmatrix.sh/app"));
    assertFalse(AppConfiguration.isUnambiguousAddress("https://evil.example@xmatrix.sh/app"));
    assertFalse(AppConfiguration.isUnambiguousAddress("https://xmatrix.sh\\.evil.example/"));
    assertFalse(AppConfiguration.isUnambiguousAddress(null));
  }
}
