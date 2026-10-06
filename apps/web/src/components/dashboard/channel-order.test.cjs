const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadWorkspaceShellModuleMap,
  extractFunctionSource,
  extractFunctionFromShellModules,
  evaluateExtractedSource,
} = require("./workspace-shell-source-fixture.cjs");

const shellModules = loadWorkspaceShellModuleMap(__dirname);
const channelLinksSource = fs.readFileSync(path.join(__dirname, "channel-links.ts"), "utf8");

// Extract the real ordering code and run it, so this file fails on behaviour
// rather than on how the comparators happen to be spelled. Every helper below
// is a self-contained pure function, so the extracted set needs no stubs.
const ORDERING_FUNCTIONS = [
  "timestampMs",
  "channelRecentActivityMs",
  "channelPinnedAtMs",
  "channelIsPinned",
  "compareChannelsByRecentActivity",
  "compareChannelsForSidebar",
];

function loadOrderingModule() {
  const source = [
    extractFunctionSource(channelLinksSource, "channelTitle", { fileName: "channel-links.ts" }),
    ...ORDERING_FUNCTIONS.map(
      (name) => extractFunctionFromShellModules(shellModules, name).source
    ),
  ].join("\n\n");
  return evaluateExtractedSource(source);
}

const {
  compareChannelsForSidebar,
  compareChannelsByRecentActivity,
} = loadOrderingModule();

const CREATED_JUST_NOW = "2026-08-06T12:00:00.000Z";
const POSTED_YESTERDAY = "2026-08-05T12:00:00.000Z";

/**
 * A Channel nobody has posted in yet. Its creation time must remain an
 * activity fallback when `updatedAt` is absent or stale.
 */
function emptyChannel(id, name, updatedAt) {
  return { id, name, updatedAt };
}

function channelWithMessage(id, name, sentAt) {
  return { id, name, updatedAt: sentAt, lastMessage: { sentAt } };
}

test("the sidebar puts a just-created empty channel above older channels with messages", () => {
  const channels = [
    channelWithMessage("old-1", "yesterday-chat", POSTED_YESTERDAY),
    emptyChannel("new-1", "brand-new", CREATED_JUST_NOW),
    channelWithMessage("old-2", "older-chat", "2026-08-04T12:00:00.000Z"),
  ];
  const sorted = [...channels].sort(compareChannelsForSidebar);
  assert.deepEqual(
    sorted.map((channel) => channel.name),
    ["brand-new", "yesterday-chat", "older-chat"]
  );
});

test("a channel posted in more recently still outranks an older empty channel", () => {
  // Guards the inverse of the bug: ranking on updatedAt must not stop tracking
  // message activity.
  const empty = emptyChannel("new-1", "created-this-morning", "2026-08-06T09:00:00.000Z");
  const active = channelWithMessage("old-1", "posted-at-noon", CREATED_JUST_NOW);
  assert.ok(compareChannelsByRecentActivity(active, empty) < 0);
  assert.ok(compareChannelsByRecentActivity(empty, active) > 0);
});

test("a newer message outranks a later cached Channel property timestamp", () => {
  const latestMessage = {
    id: "message-newest",
    name: "message-newest",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
    lastMessage: { sentAt: "2026-08-07T12:00:00.000Z" },
  };
  const laterPropertyUpdate = {
    id: "property-newest",
    name: "property-newest",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-06T12:00:00.000Z",
  };

  assert.deepEqual(
    [laterPropertyUpdate, latestMessage]
      .sort(compareChannelsByRecentActivity)
      .map((channel) => channel.name),
    ["message-newest", "property-newest"]
  );
});

test("a newer creation time outranks stale Channel properties and messages", () => {
  const newlyCreated = {
    id: "newly-created",
    name: "newly-created",
    createdAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
  };
  const olderActivity = {
    id: "older-activity",
    name: "older-activity",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-06T12:00:00.000Z",
    lastMessage: { sentAt: "2026-08-05T12:00:00.000Z" },
  };

  assert.ok(compareChannelsByRecentActivity(newlyCreated, olderActivity) < 0);
});

test("channels with identical activity fall back to title order", () => {
  const b = emptyChannel("b", "beta", CREATED_JUST_NOW);
  const a = emptyChannel("a", "alpha", CREATED_JUST_NOW);
  assert.deepEqual(
    [b, a].sort(compareChannelsByRecentActivity).map((channel) => channel.name),
    ["alpha", "beta"]
  );
});

test("pinned channels still outrank a just-created empty channel", () => {
  const pinned = {
    ...channelWithMessage("pinned-1", "pinned-chat", "2026-08-01T12:00:00.000Z"),
    metadata: { pinned: true, pinnedAt: "2026-08-01T12:00:00.000Z" },
  };
  const sorted = [emptyChannel("new-1", "brand-new", CREATED_JUST_NOW), pinned].sort(
    compareChannelsForSidebar
  );
  assert.deepEqual(
    sorted.map((channel) => channel.name),
    ["pinned-chat", "brand-new"]
  );
});
