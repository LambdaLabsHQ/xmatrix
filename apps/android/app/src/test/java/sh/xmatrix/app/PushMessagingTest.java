package sh.xmatrix.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PushMessagingTest {
  @Test
  public void aPushedNotificationOnlyLeadsToAConversationId() {
    assertTrue(PushMessaging.isConversationId("b230b57c-222d-4223-a9ec-a0b319680b1c"));
    assertTrue(PushMessaging.isConversationId("channel:personal_1"));
    assertFalse(PushMessaging.isConversationId(null));
    assertFalse(PushMessaging.isConversationId(""));
    assertFalse(PushMessaging.isConversationId("abc/../../login?next=https://example.test"));
    assertFalse(PushMessaging.isConversationId("a b"));
    assertFalse(PushMessaging.isConversationId("a".repeat(201)));
  }
}
