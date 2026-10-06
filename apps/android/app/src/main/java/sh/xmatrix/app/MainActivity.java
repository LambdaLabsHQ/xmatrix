package sh.xmatrix.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

public final class MainActivity extends ComponentActivity {
  private static final int NOTIFICATION_PERMISSION_REQUEST = 9001;
  private WebView webView;
  private NativeBridge bridge;
  private WebViewAssetLoader assetLoader;
  private boolean bridgeInstalled;
  private boolean backRequestInFlight;
  private volatile boolean usePackagedAssets;
  private final OnBackPressedCallback backCallback = new OnBackPressedCallback(true) {
    @Override
    public void handleOnBackPressed() {
      dispatchBackToWeb();
    }
  };

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    getOnBackPressedDispatcher().addCallback(this, backCallback);

    webView = new WebView(this);
    bridge = new NativeBridge(this);
    assetLoader = new WebViewAssetLoader.Builder()
      .setDomain(AppConfiguration.WEB_HOST)
      .addPathHandler("/", new PackagedWebAssets(this))
      .build();

    bridgeInstalled = configureWebView(webView);
    FrameLayout contentRoot = createInsetAwareContentRoot();
    contentRoot.addView(webView, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    setContentView(contentRoot);
    ViewCompat.requestApplyInsets(contentRoot);

    if (bridgeInstalled) {
      loadInitialUrl(getIntent());
    } else {
      showUnsupportedWebView();
    }
  }

  private FrameLayout createInsetAwareContentRoot() {
    FrameLayout contentRoot = new FrameLayout(this);
    contentRoot.setBackgroundColor(Color.rgb(245, 239, 229));
    ViewCompat.setOnApplyWindowInsetsListener(contentRoot, (view, windowInsets) -> {
      Insets systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
      Insets displayCutout = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout());
      SystemBarInsets padding = SystemBarInsets.resolve(
        systemBars.left,
        systemBars.top,
        systemBars.right,
        systemBars.bottom,
        displayCutout.left,
        displayCutout.top,
        displayCutout.right,
        displayCutout.bottom
      );
      view.setPadding(padding.left(), padding.top(), padding.right(), padding.bottom());
      return windowInsets.inset(padding.left(), padding.top(), padding.right(), padding.bottom());
    });
    return contentRoot;
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    if (bridgeInstalled) {
      Uri uri = intent == null ? null : intent.getData();
      if (!AppConfiguration.isNativeLoginResume(uri)) {
        loadInitialUrl(intent);
      }
    } else {
      showUnsupportedWebView();
    }
  }

  @Override
  protected void onDestroy() {
    backRequestInFlight = false;
    if (webView != null) {
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }

  private void dispatchBackToWeb() {
    WebView currentWebView = webView;
    if (currentWebView == null) {
      finish();
      return;
    }
    if (!bridgeInstalled || backRequestInFlight) {
      if (!backRequestInFlight) navigateWebViewBackOrFinish(currentWebView);
      return;
    }

    backRequestInFlight = true;
    WebBackNavigation.dispatch(currentWebView, handled -> {
      backRequestInFlight = false;
      if (webView != currentWebView || handled) return;
      navigateWebViewBackOrFinish(currentWebView);
    });
  }

  private void navigateWebViewBackOrFinish(WebView currentWebView) {
    if (currentWebView.canGoBack()) {
      currentWebView.goBack();
    } else {
      finish();
    }
  }

  void requestNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_PERMISSION_REQUEST);
    }
  }

  @SuppressWarnings("deprecation")
  private boolean configureWebView(WebView view) {
    view.setBackgroundColor(Color.rgb(245, 239, 229));
    view.setWebChromeClient(new WebChromeClient());
    view.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest request) {
        return usePackagedAssets ? assetLoader.shouldInterceptRequest(request.getUrl()) : null;
      }

      @Override
      public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
        return handleUrl(request.getUrl());
      }

      @Override
      public void onReceivedError(WebView webView, WebResourceRequest request, WebResourceError error) {
        if (shouldFallbackToPackagedAssets(request)) {
          loadPackagedFallback(request.getUrl());
        }
      }
    });

    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    settings.setSupportZoom(false);
    settings.setBuiltInZoomControls(false);
    settings.setDisplayZoomControls(false);
    return TrustedWebBridge.install(view, bridge);
  }

  private void loadInitialUrl(Intent intent) {
    usePackagedAssets = false;
    Uri uri = intent == null ? null : intent.getData();
    String targetUrl;
    if (uri != null && AppConfiguration.APP_SCHEME.equalsIgnoreCase(uri.getScheme())) {
      targetUrl = AppConfiguration.mapDeepLink(uri);
    } else if (uri != null && AppConfiguration.isTrustedNavigation(uri)) {
      targetUrl = uri.toString();
    } else {
      targetUrl = AppConfiguration.START_URL;
    }
    webView.loadUrl(targetUrl);
  }

  private boolean handleUrl(Uri uri) {
    if (AppConfiguration.APP_SCHEME.equalsIgnoreCase(uri.getScheme())) {
      usePackagedAssets = false;
      String targetUrl = AppConfiguration.mapDeepLink(uri);
      webView.loadUrl(targetUrl);
      return true;
    }
    if (AppConfiguration.isTrustedNavigation(uri)) {
      return false;
    }

    if (AppConfiguration.isSafeExternalUrl(uri)) {
      openExternal(uri);
    }
    return true;
  }

  boolean openExternal(Uri uri) {
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, uri));
      return true;
    } catch (ActivityNotFoundException ignored) {
      // The WebView keeps the current page when no browser or mail app can handle the URL.
      return false;
    }
  }

  private boolean shouldFallbackToPackagedAssets(WebResourceRequest request) {
    if (usePackagedAssets || request == null || !request.isForMainFrame()) {
      return false;
    }

    Uri uri = request.getUrl();
    if (uri == null || !AppConfiguration.isTrustedNavigation(uri)) {
      return false;
    }

    String host = uri.getHost();
    return host != null && AppConfiguration.WEB_HOST.equalsIgnoreCase(host);
  }

  private void loadPackagedFallback(Uri uri) {
    usePackagedAssets = true;
    String targetUrl = uri == null ? AppConfiguration.START_URL : uri.toString();
    webView.loadUrl(targetUrl);
  }

  private void showUnsupportedWebView() {
    String html = "<html style=\"color-scheme:light\"><body style=\"background:#f5efe5;color:#2a1c10;font-family:sans-serif;padding:32px\">"
      + "<h2>Android System WebView update required</h2>"
      + "<p>Update Android System WebView or Chrome, then reopen xMatrix.</p>"
      + "</body></html>";
    webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
  }
}
