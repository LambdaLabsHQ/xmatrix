package sh.xmatrix.app;

import android.webkit.WebView;
import java.util.function.Consumer;

final class WebBackNavigation {
  static void dispatch(WebView webView, Consumer<Boolean> callback) {
    try {
      webView.evaluateJavascript(dispatchScript(), result -> callback.accept(wasHandled(result)));
    } catch (RuntimeException error) {
      callback.accept(false);
    }
  }

  static String dispatchScript() {
    return "(() => {"
      + "const bridge=window.xmatrixDesktop;"
      + "if(!bridge||bridge.client!=='android'||typeof bridge.__dispatchBackRequested!=='function')return false;"
      + "try{return bridge.__dispatchBackRequested()===true;}catch(error){console.error('Android back dispatch failed',error);return false;}"
      + "})()";
  }

  static boolean wasHandled(String javascriptResult) {
    return "true".equals(javascriptResult);
  }

  private WebBackNavigation() {}
}
