const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "use-workspace-shell-state.ts"), "utf8").replace(/\r\n/g, "\n");

test("the Human socket is kept up by the shared reconnecting socket", () => {
  // One dial at a time, backoff, heartbeat and resume live in one place
  // (src/lib/connectivity/reconnecting-socket.ts), not in this hook.
  assert.match(source, /new ReconnectingSocket\(\{/);
  assert.doesNotMatch(source, /new WebSocket\(relayUrl\(\)\)\s*;/, "no hand-rolled dial outside the primitive");
  assert.doesNotMatch(source, /listenForHumanSocketResume|scheduleReconnect/);
  assert.match(source, /heartbeat: \{\s*intervalMs: RELAY_PUSH_PING_INTERVAL_MS,/);
});

test("a token renewal does not drop a working Human socket", () => {
  const effect = source.slice(source.indexOf("const connection = new ReconnectingSocket({"));
  assert.match(effect, /token: tokenRef\.current,/, "the socket reads the token when it dials");
  assert.match(source, /if \(token && !relayPushConnectedRef\.current\) humanConnectionRef\.current\?\.replace\(\);/);
});

test("a reconnect re-reads what pushes missed while the socket was down", () => {
  const connected = source.slice(source.indexOf('case "human_connected":'), source.indexOf('case "space_channel_catalog_changed":'));
  assert.match(connected, /connection\.markHealthy\(\);/);
  assert.match(connected, /if \(connectedBefore\) \{/);
  for (const key of ["xmatrixQueryKeys.spaces(identity)", '"workspace-projects"', '"workspace-events"',
    "invalidateWorkspaceResources(queryClient)"]) {
    assert.ok(connected.includes(key), key);
  }
});
