const assert = require("node:assert/strict");
const test = require("node:test");
const { loadWorkspaceShellSource } = require("./workspace-shell-source-fixture.cjs");

const shellSource = loadWorkspaceShellSource(__dirname);

test("async connector result Channels preserve originating-send navigation", () => {
  assert.match(
    shellSource,
    /case "app_connector_result_channels":/,
    "the Human realtime result event must be handled",
  );
  assert.match(
    shellSource,
    /outboundClientIdsByMessageIdRef\.current\.has\(message\.sourceMessageId\)/,
    "only the browser that sent the source message may auto-navigate",
  );
  assert.match(
    shellSource,
    /message\.channels\.find\(\(resultChannel\) => isThreadChannel\(resultChannel\)\)/,
    "thread results remain the preferred navigation target",
  );
});
