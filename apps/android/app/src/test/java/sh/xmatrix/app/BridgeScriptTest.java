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
    assertTrue(source.contains("window.top !== window"));
    assertTrue(source.contains("currentVersion: '0.15.68-test'"));
    assertFalse(source.contains("window.xmatrixNative.invoke"));
  }
}
