package sh.xmatrix.app;

import android.net.Uri;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

final class TrustedWebBridge {
  private static final String JAVASCRIPT_OBJECT_NAME = "xmatrixNative";

  static boolean install(WebView webView, NativeBridge bridge) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
      || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      return false;
    }

    WebViewCompat.addWebMessageListener(
      webView,
      JAVASCRIPT_OBJECT_NAME,
      AppConfiguration.trustedBridgeOriginRules(BuildConfig.DEBUG),
      (view, message, sourceOrigin, isMainFrame, replyProxy) ->
        handleMessage(bridge, message, sourceOrigin, isMainFrame, replyProxy)
    );
    WebViewCompat.addDocumentStartJavaScript(
      webView,
      BridgeScript.source(BuildConfig.VERSION_NAME),
      AppConfiguration.trustedBridgeOriginRules(BuildConfig.DEBUG)
    );
    return true;
  }

  private static void handleMessage(
    NativeBridge bridge,
    WebMessageCompat message,
    Uri sourceOrigin,
    boolean isMainFrame,
    JavaScriptReplyProxy replyProxy
  ) {
    if (!isMainFrame || !AppConfiguration.isTrustedBridgeOrigin(sourceOrigin)) {
      return;
    }

    String requestId = "";
    try {
      BridgeProtocol.Request request = BridgeProtocol.parseRequest(message.getData());
      requestId = request.id;
      String response = bridge.invoke(request.method, request.payload.toString());
      replyProxy.postMessage(BridgeProtocol.reply(request.id, response));
    } catch (Exception error) {
      replyProxy.postMessage(BridgeProtocol.failureReply(requestId, error.getMessage()));
    }
  }

  private TrustedWebBridge() {}
}
