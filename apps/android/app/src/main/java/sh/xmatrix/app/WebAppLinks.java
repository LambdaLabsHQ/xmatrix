package sh.xmatrix.app;

import android.webkit.WebView;
import java.util.function.Consumer;

/**
 * Tells the running page a link is waiting. The script is constant: the page
 * collects the address over the origin-checked bridge, so nothing an Intent
 * carried is ever evaluated as script.
 */
final class WebAppLinks {
  static final String ANNOUNCE_SCRIPT = "(() => {"
    + "const bridge=window.xmatrixDesktop;"
    + "if(!bridge||bridge.client!=='android'||typeof bridge.__openPendingAppLink!=='function')return false;"
    + "bridge.__openPendingAppLink();"
    + "return true;"
    + "})()";

  /** Answers whether the page can collect the link. */
  static void announce(WebView webView, Consumer<Boolean> callback) {
    try {
      webView.evaluateJavascript(ANNOUNCE_SCRIPT, result -> callback.accept(WebBackNavigation.wasHandled(result)));
    } catch (RuntimeException error) {
      callback.accept(false);
    }
  }

  private WebAppLinks() {}
}
