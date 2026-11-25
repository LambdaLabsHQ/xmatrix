package sh.xmatrix.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import org.junit.Test;

public final class StoreReviewPromptTest {
  @Test
  public void requiresThreeDistinctUtcDaysAndNinetyDayCooldown() {
    long day1 = 1_795_564_800_000L; // 2026-11-25T00:00:00Z
    long day = 86_400_000L;

    StoreReviewPrompt.Decision d1 = StoreReviewPrompt.evaluate(Collections.emptySet(), 0L, StoreReviewPrompt.utcDayKey(day1), day1);
    assertFalse(d1.shouldPrompt);
    assertEquals(1, d1.updatedDays.size());

    StoreReviewPrompt.Decision d1Again = StoreReviewPrompt.evaluate(d1.updatedDays, d1.updatedLastPromptedMs, StoreReviewPrompt.utcDayKey(day1 + 3_600_000L), day1 + 3_600_000L);
    assertFalse(d1Again.shouldPrompt);
    assertEquals(1, d1Again.updatedDays.size());

    StoreReviewPrompt.Decision d2 = StoreReviewPrompt.evaluate(d1Again.updatedDays, d1Again.updatedLastPromptedMs, StoreReviewPrompt.utcDayKey(day1 + day), day1 + day);
    assertFalse(d2.shouldPrompt);

    long day3 = day1 + 2 * day;
    StoreReviewPrompt.Decision d3 = StoreReviewPrompt.evaluate(d2.updatedDays, d2.updatedLastPromptedMs, StoreReviewPrompt.utcDayKey(day3), day3);
    assertTrue(d3.shouldPrompt);
    assertEquals(day3, d3.updatedLastPromptedMs);

    long day89Later = day3 + 89 * day;
    StoreReviewPrompt.Decision d89 = StoreReviewPrompt.evaluate(d3.updatedDays, d3.updatedLastPromptedMs, StoreReviewPrompt.utcDayKey(day89Later), day89Later);
    assertFalse(d89.shouldPrompt);

    long day90Later = day3 + 90 * day;
    StoreReviewPrompt.Decision d90 = StoreReviewPrompt.evaluate(d89.updatedDays, d89.updatedLastPromptedMs, StoreReviewPrompt.utcDayKey(day90Later), day90Later);
    assertTrue(d90.shouldPrompt);
    assertEquals(day90Later, d90.updatedLastPromptedMs);
  }
}
