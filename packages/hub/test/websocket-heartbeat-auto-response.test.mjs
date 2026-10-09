import assert from "node:assert/strict";
import test from "node:test";

import { HUMAN_HEARTBEAT_PING, HUMAN_HEARTBEAT_PONG } from "@xmatrix/protocol";

// The runtime answers the Human socket's heartbeat byte for byte without
// waking the object, and the web parses the answer as a pong.
test("the web heartbeat pair is a ping and its matching pong", () => {
  assert.deepEqual(JSON.parse(HUMAN_HEARTBEAT_PING), { type: "ping", requestId: "web-heartbeat" });
  assert.deepEqual(JSON.parse(HUMAN_HEARTBEAT_PONG), { type: "pong", requestId: "web-heartbeat" });
});
