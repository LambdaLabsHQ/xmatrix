package sh.xmatrix.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Set;
import org.junit.Test;

public final class AppConfigurationTest {
  @Test
  public void productionBridgeOriginsAreExactAndHttpsOnly() {
    Set<String> rules = AppConfiguration.trustedBridgeOriginRules(false);

    assertEquals(Set.of("https://xmatrix.sh", "https://www.xmatrix.sh", "https://test.xmatrix.sh"), rules);
    assertTrue(AppConfiguration.isTrustedBridgeOrigin("https", "xmatrix.sh", -1, false));
    assertTrue(AppConfiguration.isTrustedBridgeOrigin("https", "www.xmatrix.sh", 443, false));
    assertTrue(AppConfiguration.isTrustedBridgeOrigin("https", "test.xmatrix.sh", 443, false));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin("http", "xmatrix.sh", -1, false));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin("https", "xmatrix.sh", 8443, false));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin("https", "auth.xmatrix.sh", -1, false));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin("https", "evil.test.xmatrix.sh", -1, false));
  }

  @Test
  public void debugBridgeOriginsAllowOnlyLoopbackDevelopmentHosts() {
    Set<String> rules = AppConfiguration.trustedBridgeOriginRules(true);

    assertTrue(rules.contains("http://localhost:3001"));
    assertTrue(rules.contains("http://127.0.0.1:3000"));
    assertTrue(rules.contains("http://[::1]:3001"));
    assertFalse(rules.stream().anyMatch((rule) -> rule.contains(":*")));
    assertTrue(AppConfiguration.isTrustedBridgeOrigin("http", "localhost", 3000, true));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin("http", "localhost", 4611, true));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin("https", "localhost", 3001, true));
    assertFalse(AppConfiguration.isTrustedBridgeOrigin("http", "192.168.1.2", 3000, true));
  }

  @Test
  public void bareNativeLoginReturnOnlyResumesTheExistingWebView() {
    assertTrue(AppConfiguration.isNativeLoginResume("xmatrix", "login", null));
    assertTrue(AppConfiguration.isNativeLoginResume("XMATRIX", "LOGIN", ""));
    assertFalse(AppConfiguration.isNativeLoginResume("https", "login", null));
    assertFalse(AppConfiguration.isNativeLoginResume("xmatrix", "channel", null));
    assertFalse(AppConfiguration.isNativeLoginResume("xmatrix", "login", "auth_error=denied"));
  }
}
