package sh.xmatrix.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class WebBackNavigationTest {
  @Test
  public void dispatchesOnlyToTheAndroidBridge() {
    String source = WebBackNavigation.dispatchScript();

    assertTrue(source.contains("bridge.client!=='android'"));
    assertTrue(source.contains("bridge.__dispatchBackRequested()===true"));
  }

  @Test
  public void acceptsOnlyAnExplicitJavascriptTrueResult() {
    assertTrue(WebBackNavigation.wasHandled("true"));
    assertFalse(WebBackNavigation.wasHandled("false"));
    assertFalse(WebBackNavigation.wasHandled("null"));
    assertFalse(WebBackNavigation.wasHandled(null));
  }
}
