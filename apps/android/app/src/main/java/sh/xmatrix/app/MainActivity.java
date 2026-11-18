package sh.xmatrix.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * The app's only door for other apps: the launcher, `xmatrix://` links and
 * tapped pushes. It holds no WebView and passes on only what
 * AppConfiguration.entryLink accepts. The name stays, because home-screen
 * shortcuts point at it.
 */
public final class MainActivity extends Activity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    Intent incoming = getIntent();
    String link = checkedLink(incoming);
    if (link != null || isTaskRoot() || !isLauncherTap(incoming)) {
      Intent page = new Intent(this, WebAppActivity.class)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
      if (link != null) page.setData(Uri.parse(link));
      startActivity(page);
    }
    // A launcher tap on a running app just brings it back as it was left.
    finish();
  }

  private static boolean isLauncherTap(Intent intent) {
    return intent != null
      && Intent.ACTION_MAIN.equals(intent.getAction())
      && intent.hasCategory(Intent.CATEGORY_LAUNCHER);
  }

  private static String checkedLink(Intent intent) {
    try {
      Uri uri = intent == null ? null : intent.getData();
      if (uri == null) uri = PushMessaging.conversationLink(intent);
      if (uri == null || uri.isOpaque()) return null;
      return AppConfiguration.entryLink(
        AppConfiguration.WEB_HOST, uri.getScheme(), uri.getHost(), uri.getPath(), uri.getEncodedQuery());
    } catch (RuntimeException malformed) {
      // Another app's Intent can carry extras that cannot be read.
      return null;
    }
  }
}
