package sh.xmatrix.app;

import android.content.Context;
import android.content.SharedPreferences;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Gentle, locally-throttled Google Play In-App Review prompt triggered only
 * after signed-in engagement across multiple distinct UTC days.
 */
final class StoreReviewPrompt {
  static final int MIN_ACTIVE_DAYS = 3;
  static final long COOLDOWN_MS = 90L * 86_400_000L;
  private static final int MAX_STORED_DAYS = 10;
  private static final String PREFS_NAME = "xmatrix_store_review";
  private static final String KEY_ACTIVE_DAYS = "active_days";
  private static final String KEY_LAST_PROMPTED_MS = "last_prompted_ms";
  private static final DateTimeFormatter UTC_DAY = DateTimeFormatter.ISO_LOCAL_DATE.withZone(ZoneOffset.UTC);

  static final class Decision {
    final Set<String> updatedDays;
    final long updatedLastPromptedMs;
    final boolean shouldPrompt;

    Decision(Set<String> updatedDays, long updatedLastPromptedMs, boolean shouldPrompt) {
      this.updatedDays = updatedDays;
      this.updatedLastPromptedMs = updatedLastPromptedMs;
      this.shouldPrompt = shouldPrompt;
    }
  }

  static String utcDayKey(long nowMs) {
    return UTC_DAY.format(Instant.ofEpochMilli(nowMs));
  }

  static Decision evaluate(Set<String> existingDays, long lastPromptedAtMs, String todayIso, long nowMs) {
    Set<String> merged = new HashSet<>();
    if (existingDays != null) merged.addAll(existingDays);
    if (todayIso != null && !todayIso.isEmpty()) merged.add(todayIso);

    List<String> sorted = new ArrayList<>(merged);
    Collections.sort(sorted);
    if (sorted.size() > MAX_STORED_DAYS) {
      sorted = sorted.subList(sorted.size() - MAX_STORED_DAYS, sorted.size());
    }
    Set<String> bounded = new HashSet<>(sorted);

    boolean enoughDays = bounded.size() >= MIN_ACTIVE_DAYS;
    boolean cooledDown = lastPromptedAtMs <= 0L || (nowMs - lastPromptedAtMs) >= COOLDOWN_MS;
    if (enoughDays && cooledDown) {
      return new Decision(bounded, nowMs, true);
    }
    return new Decision(bounded, lastPromptedAtMs, false);
  }

  static boolean requestIfEligible(WebAppActivity activity) {
    if (activity == null || activity.isFinishing() || activity.isDestroyed()) return false;
    long nowMs = System.currentTimeMillis();
    SharedPreferences prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    Set<String> existing = prefs.getStringSet(KEY_ACTIVE_DAYS, Collections.emptySet());
    long lastPromptedAtMs = prefs.getLong(KEY_LAST_PROMPTED_MS, 0L);

    Decision decision = evaluate(existing, lastPromptedAtMs, utcDayKey(nowMs), nowMs);
    prefs.edit()
      .putStringSet(KEY_ACTIVE_DAYS, decision.updatedDays)
      .putLong(KEY_LAST_PROMPTED_MS, decision.updatedLastPromptedMs)
      .apply();
    if (!decision.shouldPrompt) return false;

    activity.runOnUiThread(() -> {
      if (activity.isFinishing() || activity.isDestroyed()) return;
      try {
        ReviewManager manager = ReviewManagerFactory.create(activity);
        manager.requestReviewFlow().addOnCompleteListener(task -> {
          if (!task.isSuccessful() || activity.isFinishing() || activity.isDestroyed()) return;
          try {
            manager.launchReviewFlow(activity, task.getResult());
          } catch (Exception ignored) {
            // Review prompts are optional; never surface store errors to the user.
          }
        });
      } catch (Exception ignored) {
        // Non-Play devices or emulators may not support In-App Review.
      }
    });
    return true;
  }

  private StoreReviewPrompt() {}
}
