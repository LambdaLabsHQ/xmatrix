const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "use-workspace-shell-state.ts"), "utf8").replace(/\r\n/g, "\n");

function body(name) {
  const start = source.indexOf(`    function ${name}(`);
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf("\n    }\n", start));
}

test("a delayed redial never opens a second Human socket", () => {
  // The 1006 compatibility check can resolve after a resume already dialled.
  assert.match(body("scheduleReconnect"), /if \(cancelled \|\| socket\) return;/);
  assert.match(body("scheduleReconnect"), /window\.clearTimeout\(reconnectTimer\)/);
  assert.match(body("connect"), /if \(cancelled \|\| socket\) return;/);
});

test("a reconnect re-reads what pushes missed while the socket was down", () => {
  const connected = source.slice(source.indexOf('case "human_connected":'), source.indexOf('case "space_channel_catalog_changed":'));
  assert.match(connected, /if \(connectedBefore\) \{/);
  for (const key of ["xmatrixQueryKeys.spaces(identity)", '"workspace-projects"', '"workspace-events"',
    "invalidateWorkspaceResources(queryClient)"]) {
    assert.ok(connected.includes(key), key);
  }
});
