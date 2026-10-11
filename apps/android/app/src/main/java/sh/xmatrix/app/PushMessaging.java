package sh.xmatrix.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.function.Consumer;

/** This device's address at Firebase Cloud Messaging, and where a pushed notification leads. */
final class PushMessaging {
  /** The key the Hub puts a notification's conversation under. */
  private static final String CHANNEL_ID_EXTRA = "channelId";

  /** A build without the Firebase app's identifiers has no push. */
  static boolean configured() {
    return !BuildConfig.FIREBASE_APP_ID.isEmpty()
      && !BuildConfig.FIREBASE_API_KEY.isEmpty()
      && !BuildConfig.FIREBASE_SENDER_ID.isEmpty()
      && !BuildConfig.FIREBASE_PROJECT_ID.isEmpty();
  }

  /** Hands over the registration token, or null when this build or device has none. Answers on the main thread. */
  static void token(Context context, Consumer<String> done) {
    if (!configured()) {
      done.accept(null);
      return;
    }
    try {
      Context application = context.getApplicationContext();
      if (FirebaseApp.getApps(application).isEmpty()) {
        FirebaseApp.initializeApp(application, new FirebaseOptions.Builder()
          .setApplicationId(BuildConfig.FIREBASE_APP_ID)
          .setApiKey(BuildConfig.FIREBASE_API_KEY)
          .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
          .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
          .build());
      }
      FirebaseMessaging.getInstance().getToken()
        .addOnCompleteListener(task -> done.accept(task.isSuccessful() ? task.getResult() : null));
    } catch (RuntimeException error) {
      done.accept(null);
    }
  }

  /** The conversation a tapped push names, as the app's own deep link; null for any other launch. */
  static Uri conversationLink(Intent intent) {
    String channelId = intent == null ? null : intent.getStringExtra(CHANNEL_ID_EXTRA);
    return isConversationId(channelId) ? Uri.parse("xmatrix://channel/" + channelId) : null;
  }

  static boolean isConversationId(String value) {
    return value != null && value.matches("[A-Za-z0-9:_-]{1,200}");
  }

  private PushMessaging() {}
}
