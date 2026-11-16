package sh.xmatrix.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class BridgeScriptTest {
  @Test
  public void exposesAndroidIdentityThroughAnAsynchronousMessageBridge() {
    String source = BridgeScript.source("0.15.68-test");

    assertTrue(source.contains("client: 'android'"));
    assertTrue(source.contains("platform: 'android'"));
    assertTrue(source.contains("window.xmatrixNative.onmessage"));
    assertTrue(source.contains("window.xmatrixNative.postMessage"));
    assertTrue(source.contains("onBackRequested: (listener)"));
    assertTrue(source.contains("__dispatchBackRequested"));
    assertTrue(source.contains("pushDevice: () => invoke('pushDevice')"));
    assertTrue(source.contains("window.top !== window"));
    assertTrue(source.contains("currentVersion: '0.15.68-test'"));
    assertFalse(source.contains("window.xmatrixNative.invoke"));
  }

  @Test
  public void sellsSubscriptionsOnlyThroughGooglePlay() {
    String source = BridgeScript.source("4.0.7-test");

    for (String method : new String[] {"googlePlayProducts", "googlePlayPurchase", "googlePlayPurchases", "googlePlayManage"}) {
      assertTrue(method, source.contains(method + ": (input) => invoke('" + method + "', input)"));
    }
  }
}
