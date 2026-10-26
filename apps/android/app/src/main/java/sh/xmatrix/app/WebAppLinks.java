package sh.xmatrix.app;

import android.webkit.WebView;
import java.util.function.Consumer;

/** Hands a notification's or link's address to the running page, which answers whether it opened it. */
final class WebAppLinks {
  static void open(WebView webView, String url, Consumer<Boolean> callback) {
    try {
      webView.evaluateJavascript(openScript(url), result -> callback.accept(WebBackNavigation.wasHandled(result)));
    } catch (RuntimeException error) {
      callback.accept(false);
    }
  }

  static String openScript(String url) {
    return "(() => {"
      + "const bridge=window.xmatrixDesktop;"
      + "if(!bridge||bridge.client!=='android'||typeof bridge.__openAppLink!=='function')return false;"
      + "try{return bridge.__openAppLink(" + BridgeScript.quote(url) + ")===true;}catch(error){console.error('Android app link failed',error);return false;}"
      + "})()";
  }

  private WebAppLinks() {}
}
