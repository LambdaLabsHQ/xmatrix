package sh.xmatrix.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public final class BridgeProtocolTest {
  @Test
  public void parsesACompleteRequest() throws Exception {
    BridgeProtocol.Request request = BridgeProtocol.parseRequest(
      "{\"id\":\"android-1\",\"method\":\"setBadge\",\"payload\":{\"count\":4}}"
    );

    assertEquals("android-1", request.id);
    assertEquals("setBadge", request.method);
    assertEquals(4, request.payload.getInt("count"));
  }

  @Test
  public void rejectsRequestsWithoutIdentityOrMethod() {
    assertThrows(IllegalArgumentException.class, () -> BridgeProtocol.parseRequest("{\"method\":\"getContext\"}"));
    assertThrows(IllegalArgumentException.class, () -> BridgeProtocol.parseRequest("{\"id\":\"android-1\"}"));
  }

  @Test
  public void rejectsWrongTypesAndOversizedFields() {
    assertThrows(
      IllegalArgumentException.class,
      () -> BridgeProtocol.parseRequest("{\"id\":1,\"method\":\"getContext\"}")
    );
    assertThrows(
      IllegalArgumentException.class,
      () -> BridgeProtocol.parseRequest("{\"id\":\"android-1\",\"method\":\"notify\",\"payload\":[]}")
    );
    assertThrows(
      IllegalArgumentException.class,
      () -> BridgeProtocol.parseRequest(
        "{\"id\":\"" + "a".repeat(129) + "\",\"method\":\"getContext\"}"
      )
    );
  }

  @Test
  public void wrapsNativeResponsesForTheMatchingJavascriptPromise() throws Exception {
    JSONObject message = new JSONObject(
      BridgeProtocol.reply("android-7", "{\"ok\":true,\"value\":{\"client\":\"android\"}}")
    );

    assertEquals("android-7", message.getString("id"));
    assertTrue(message.getJSONObject("response").getBoolean("ok"));
    assertEquals("android", message.getJSONObject("response").getJSONObject("value").getString("client"));

    JSONObject failure = new JSONObject(BridgeProtocol.reply("android-8", "not-json"));
    assertFalse(failure.getJSONObject("response").getBoolean("ok"));
  }
}
