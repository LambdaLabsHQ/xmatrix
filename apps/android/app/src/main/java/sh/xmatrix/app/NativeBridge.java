package sh.xmatrix.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import org.json.JSONObject;

public final class NativeBridge {
  private static final String CHANNEL_ID = "xmatrix-default";
  private final MainActivity activity;

  NativeBridge(MainActivity activity) {
    this.activity = activity;
    ensureNotificationChannel();
  }

  String invoke(String method, String payloadJson) {
    try {
      JSONObject payload = payloadJson == null || payloadJson.isEmpty() ? new JSONObject() : new JSONObject(payloadJson);
      Object value;
      switch (method) {
        case "getContext":
          value = contextPayload();
          break;
        case "setBadge":
        case "setTitle":
          value = JSONObject.NULL;
          break;
        case "getNotificationSettings":
          value = notificationSettings(false);
          break;
        case "requestNotifications":
          activity.runOnUiThread(activity::requestNotificationPermissionIfNeeded);
          value = notificationSettings(true);
          break;
        case "notify":
          value = notify(payload);
          break;
        case "openExternal":
          openExternal(payload.optString("url", ""));
          value = JSONObject.NULL;
          break;
        default:
          return failure("Unsupported native bridge method: " + method);
      }
      return success(value);
    } catch (Exception error) {
      return failure(error.getMessage());
    }
  }

  private JSONObject contextPayload() throws Exception {
    return new JSONObject()
      .put("client", "android")
      .put("platform", "android")
      .put("version", BuildConfig.VERSION_NAME)
      .put("isPackaged", true)
      .put("startUrl", AppConfiguration.START_URL);
  }

  private JSONObject notificationSettings(boolean requested) throws Exception {
    boolean granted = hasNotificationPermission();
    String permission = granted ? "granted" : requested ? "not-determined" : "not-determined";
    return new JSONObject()
      .put("supported", true)
      .put("permission", permission)
      .put("alert", granted)
      .put("badge", false)
      .put("sound", granted);
  }

  private boolean notify(JSONObject payload) throws Exception {
    String title = payload.optString("title", "").trim();
    if (title.isEmpty()) {
      return false;
    }

    if (!hasNotificationPermission()) {
      activity.runOnUiThread(activity::requestNotificationPermissionIfNeeded);
      return false;
    }

    String url = payload.optString("url", "");
    String channelId = payload.optString("channelId", "");
    Intent intent = new Intent(activity, MainActivity.class);
    intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    if (!url.isEmpty()) {
      intent.setData(Uri.parse(url));
    } else if (!channelId.isEmpty()) {
      intent.setData(Uri.parse("xmatrix://channel/" + Uri.encode(channelId)));
    }

    int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) {
      pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
    }

    PendingIntent pendingIntent = PendingIntent.getActivity(
      activity,
      (int) System.currentTimeMillis(),
      intent,
      pendingFlags
    );

    NotificationCompat.Builder builder = new NotificationCompat.Builder(activity, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(title)
      .setContentText(payload.optString("body", ""))
      .setContentIntent(pendingIntent)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT);

    if (!payload.optBoolean("silent", false)) {
      builder.setDefaults(NotificationCompat.DEFAULT_SOUND);
    }

    NotificationManager manager = (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
    manager.notify((int) System.currentTimeMillis(), builder.build());
    return true;
  }

  private void openExternal(String value) {
    if (value == null || value.trim().isEmpty()) {
      return;
    }
    Uri uri = Uri.parse(value);
    if (!AppConfiguration.isSafeExternalUrl(uri)) {
      return;
    }
    if (!activity.openExternal(uri)) {
      throw new IllegalStateException("No Android app can open this link");
    }
  }

  private boolean hasNotificationPermission() {
    return Build.VERSION.SDK_INT < 33 ||
      activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
  }

  private void ensureNotificationChannel() {
    if (Build.VERSION.SDK_INT < 26) {
      return;
    }
    NotificationChannel channel = new NotificationChannel(
      CHANNEL_ID,
      "xMatrix",
      NotificationManager.IMPORTANCE_DEFAULT
    );
    NotificationManager manager = (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
    manager.createNotificationChannel(channel);
  }

  private static String success(Object value) throws Exception {
    return new JSONObject().put("ok", true).put("value", value).toString();
  }

  private static String failure(String error) {
    try {
      return new JSONObject().put("ok", false).put("error", error == null ? "Native bridge error" : error).toString();
    } catch (Exception ignored) {
      return "{\"ok\":false,\"error\":\"Native bridge error\"}";
    }
  }
}
