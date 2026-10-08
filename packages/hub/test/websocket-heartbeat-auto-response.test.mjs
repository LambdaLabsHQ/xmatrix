import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { HUMAN_HEARTBEAT_PING, HUMAN_HEARTBEAT_PONG } from "@xmatrix/protocol";

const source = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

// The platform test preload cannot construct Durable Objects, so the wiring
// is checked where it lives: each object registers its pair at construction.
test("the Human socket's object answers the web heartbeat without waking", () => {
  assert.match(source("relay-runtime.ts"),
    /ctx\.setWebSocketAutoResponse\(new WebSocketRequestResponsePair\(HUMAN_HEARTBEAT_PING, HUMAN_HEARTBEAT_PONG\)\)/);
  // Compared byte for byte by the runtime, and parsed by the web as a pong.
  assert.deepEqual(JSON.parse(HUMAN_HEARTBEAT_PING), { type: "ping", requestId: "web-heartbeat" });
  assert.deepEqual(JSON.parse(HUMAN_HEARTBEAT_PONG), { type: "pong", requestId: "web-heartbeat" });
});

test("a page session answers its heartbeat and its ticket names it", () => {
  assert.match(source("page-session-do.ts"),
    /state\.setWebSocketAutoResponse\(new WebSocketRequestResponsePair\(PAGE_SESSION_HEARTBEAT_PING, PAGE_SESSION_HEARTBEAT_PONG\)\)/);
  assert.match(source("index-routes-pages.ts"), /heartbeat: PAGE_SESSION_HEARTBEAT_PING/);
});
