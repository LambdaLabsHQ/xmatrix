package sh.xmatrix.app;

import org.json.JSONObject;

final class BridgeProtocol {
  private static final int MAX_REQUEST_LENGTH = 128 * 1024;
  private static final int MAX_REQUEST_ID_LENGTH = 128;
  private static final int MAX_METHOD_LENGTH = 128;

  static Request parseRequest(String data) throws Exception {
    if (data == null || data.length() > MAX_REQUEST_LENGTH) {
      throw new IllegalArgumentException("Native bridge request is missing or too large");
    }

    JSONObject message = new JSONObject(data);
    Object rawId = message.opt("id");
    Object rawMethod = message.opt("method");
    if (!(rawId instanceof String) || !(rawMethod instanceof String)) {
      throw new IllegalArgumentException("Native bridge request id and method must be strings");
    }

    String id = ((String) rawId).trim();
    String method = ((String) rawMethod).trim();
    if (id.isEmpty()) {
      throw new IllegalArgumentException("Native bridge request id is required");
    }
    if (id.length() > MAX_REQUEST_ID_LENGTH) {
      throw new IllegalArgumentException("Native bridge request id is too long");
    }
    if (method.isEmpty()) {
      throw new IllegalArgumentException("Native bridge method is required");
    }
    if (method.length() > MAX_METHOD_LENGTH) {
      throw new IllegalArgumentException("Native bridge method is too long");
    }

    JSONObject payload = message.optJSONObject("payload");
    if (message.has("payload") && !message.isNull("payload") && payload == null) {
      throw new IllegalArgumentException("Native bridge payload must be an object");
    }
    return new Request(id, method, payload == null ? new JSONObject() : payload);
  }

  static String reply(String id, String responseJson) {
    try {
      JSONObject response = new JSONObject(responseJson);
      return new JSONObject().put("id", id).put("response", response).toString();
    } catch (Exception error) {
      return failureReply(id, error.getMessage());
    }
  }

  static String failureReply(String id, String error) {
    try {
      JSONObject response = new JSONObject()
        .put("ok", false)
        .put("error", error == null || error.isEmpty() ? "Native bridge error" : error);
      return new JSONObject().put("id", id == null ? "" : id).put("response", response).toString();
    } catch (Exception ignored) {
      return "{\"id\":\"\",\"response\":{\"ok\":false,\"error\":\"Native bridge error\"}}";
    }
  }

  static final class Request {
    final String id;
    final String method;
    final JSONObject payload;

    Request(String id, String method, JSONObject payload) {
      this.id = id;
      this.method = method;
      this.payload = payload;
    }
  }

  private BridgeProtocol() {}
}
