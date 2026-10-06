const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  absoluteChannelUrl,
  channelAppPath,
  exactChannelIdFromRouteKey,
  parseInternalChannelLink,
  resolveChannelRouteKey,
  resolveSpaceRouteKey,
} = require("./channel-links.ts");

const spaces = [
  {
    id: "space:Team Alpha",
    name: "Team Alpha",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
  },
];

const channel = {
  id: "channel:Design/Launch 387",
  spaceId: "space:Team Alpha",
  name: "#Design & Launch",
  mode: "closed",
  createdBy: "user:1",
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
};

test("channelAppPath generates canonical app channel paths with encoded route keys", () => {
  const pathValue = channelAppPath(channel, spaces);

  assert.match(pathValue,
    /^\/app\/team-alpha-s[a-z0-9]+\/channels\/design-launch--channel%3ADesign%2FLaunch%20387$/);
  assert.equal(exactChannelIdFromRouteKey(pathValue.split("/").at(-1)), channel.id);
});

test("absoluteChannelUrl uses the current origin and canonical channel path", () => {
  assert.equal(
    absoluteChannelUrl(channel, spaces, "https://xmatrix.example"),
    `https://xmatrix.example${channelAppPath(channel, spaces)}`
  );
});

test("same-origin channel and thread links are classified as internal navigation", () => {
  const thread = {
    ...channel,
    id: "channel:thread-1",
    name: "Thread reply",
    parentChannelId: channel.id,
  };

  for (const target of [channel, thread]) {
    const link = parseInternalChannelLink(
      `${channelAppPath(target, spaces)}#message:message%3A42`,
      "https://xmatrix.example/app"
    );
    assert.deepEqual(link, {
      spaceKey: channelAppPath(target, spaces).split("/")[2],
      channelKey: decodeURIComponent(channelAppPath(target, spaces).split("/")[4]),
      messageId: "message:42",
    });
  }
});

test("a channel absent from memory can resolve after the channel list refreshes", () => {
  const link = parseInternalChannelLink(
    channelAppPath(channel, spaces),
    "https://xmatrix.example/app"
  );
  assert.ok(link);

  const spaceId = resolveSpaceRouteKey(spaces, link.spaceKey);
  assert.equal(resolveChannelRouteKey([], link.channelKey, spaceId), null);
  assert.equal(resolveChannelRouteKey([channel], link.channelKey, spaceId)?.id, channel.id);
});

test("legacy route-token links remain resolvable from an already loaded catalog", () => {
  const legacyKey = "design-launch-cchanneldes";
  assert.equal(resolveChannelRouteKey([channel], legacyKey, channel.spaceId)?.id, channel.id);
});

test("missing or inaccessible channel targets remain unresolved", () => {
  const missing = parseInternalChannelLink(
    "/app/team-alpha-sdeadbeef/channels/missing-cdeadbeef",
    "https://xmatrix.example/app"
  );
  assert.ok(missing);
  assert.equal(resolveSpaceRouteKey(spaces, missing.spaceKey), null);
  assert.equal(resolveChannelRouteKey([channel], missing.channelKey, null), null);
});

test("external web links are not classified as internal channel links", () => {
  assert.equal(
    parseInternalChannelLink(
      "https://example.com/app/team-alpha/channels/design",
      "https://xmatrix.example/app"
    ),
    null
  );
});
