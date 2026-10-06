const assert = require("node:assert/strict");
const test = require("node:test");
const { loadWorkspaceShellModuleMap, loadShellFunctions } = require("./workspace-shell-source-fixture.cjs");

const shellModules = loadWorkspaceShellModuleMap(__dirname);

const SELECTION_FUNCTIONS = [
  "resolveSelectedChannelIdAfterChannelListChange",
  "selectedChannelIdAfterRouteChange",
];

const { selectedChannelIdAfterRouteChange } = loadShellFunctions(shellModules, SELECTION_FUNCTIONS);

const READING = { id: "channel-reading", name: "reading", spaceId: "space-1" };
const OTHER = { id: "channel-other", name: "other", spaceId: "space-1" };

test("a Channel the list has not caught up with does not close the Channel being read", () => {
  // The URL still names the Channel. Only its row is missing for this pass, so
  // resolution returns null. Treating that as "the reader asked for the list"
  // is what dropped them out of the Channel and back in a moment later.
  const stayed = selectedChannelIdAfterRouteChange({
    channels: [OTHER],
    current: READING.id,
    routeChannelId: null,
    routeNamesChannel: true,
    routeSelectionChanged: true,
  });

  assert.equal(stayed, READING.id, "an unresolved route must not close the open Channel");
  assert.notEqual(stayed, OTHER.id, "and must never hand the reader a different Channel");
});

test("the Channel stays put once its row arrives", () => {
  const settled = selectedChannelIdAfterRouteChange({
    channels: [OTHER, READING],
    current: READING.id,
    routeChannelId: READING.id,
    routeNamesChannel: true,
    routeSelectionChanged: true,
  });

  assert.equal(settled, READING.id);
});

test("a route that names no Channel still closes the open Channel", () => {
  // Browser back to the Channel-list URL. The route has to win here or the
  // detail view stays over the list.
  const cleared = selectedChannelIdAfterRouteChange({
    channels: [READING, OTHER],
    current: READING.id,
    routeChannelId: null,
    routeNamesChannel: false,
    routeSelectionChanged: true,
  });

  assert.equal(cleared, null);
});

test("a reader with nothing open is never handed a Channel", () => {
  // The list is the answer when no Channel is open; landing the reader on the
  // Space's first Channel opened one they never asked for.
  const opened = selectedChannelIdAfterRouteChange({
    channels: [READING, OTHER],
    current: null,
    routeChannelId: null,
    routeNamesChannel: false,
    routeSelectionChanged: false,
  });

  assert.equal(opened, null);
});

test("repeated Channel-list churn never moves the reader", () => {
  // The list is re-identified on every presence frame, so this decision runs
  // over and over. Whatever the list is doing, the answer must not wander.
  const passes = [[OTHER], [], [READING, OTHER], [OTHER], [OTHER, READING]];
  let current = READING.id;
  for (const channels of passes) {
    const routeChannelId = channels.some((channel) => channel.id === READING.id)
      ? READING.id
      : null;
    current = selectedChannelIdAfterRouteChange({
      channels,
      current,
      routeChannelId,
      routeNamesChannel: true,
      routeSelectionChanged: true,
    });
    assert.equal(current, READING.id, "the open Channel must survive every pass");
  }
});

test("closing a page's conversation keeps it closed while the Channel list changes", () => {
  // Beside a page, nothing selected means the reader closed the conversation.
  // Landing on the Space's first Channel there docked an unrelated Channel over
  // the page's margin a few seconds after it was closed, on the next list change.
  const passes = [[READING, OTHER], [OTHER, READING], [READING]];
  for (const channels of passes) {
    assert.equal(selectedChannelIdAfterRouteChange({
      channels,
      current: null,
      routeChannelId: null,
      routeNamesChannel: false,
      routeSelectionChanged: false,
    }), null);
  }
});
