const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { channelSidebarError } = require("./workspace-sidebar-error.ts");

test("Agent turn cancellation is not rendered as a channel-catalog error", () => {
  assert.equal(channelSidebarError("The user aborted a request."), null);
  assert.equal(channelSidebarError("the user cancelled the turn"), null);
});

test("real channel-catalog failures remain visible", () => {
  assert.equal(channelSidebarError("Failed to load channels"), "Failed to load channels");
  assert.equal(channelSidebarError(null), null);
});
