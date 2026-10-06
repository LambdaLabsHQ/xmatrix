const assert = require("node:assert/strict");
const test = require("node:test");

require("./typescript-require.cjs").installTypeScriptRequire();
const {
  messageLinkOrigin,
  messageLinkOriginLabel,
  messageLinkOriginTitle,
} = require("./message-link-origin.ts");

const home = { id: "channel-home", spaceId: "space-1", name: "schema-work" };

function agentMessage(from) {
  return {
    messageId: "message-1", channelId: "channel-away", body: "can someone confirm?", sentAt: "2026-09-25T00:00:00Z",
    from: { kind: "agent", label: "claude", userId: "owner-1", email: "", instanceLabel: "claude:3", ...from },
  };
}

test("a linked Agent message names its Channel and links to the message it was handling", () => {
  const origin = messageLinkOrigin(
    agentMessage({ originChannelId: "channel-home", originMessageId: "asked-1" }), [home]);
  assert.equal(origin.kind, "link");
  assert.equal(origin.channelName, "schema-work");
  assert.match(origin.href, /\/channels\/schema-work--channel-home#message:asked-1$/u);
  assert.equal(messageLinkOriginLabel(origin), "from #schema-work");
  assert.match(messageLinkOriginTitle(origin), /Open the message it was handling/u);
});

test("a reader who cannot open the origin learns only that it came from elsewhere", () => {
  const origin = messageLinkOrigin(
    agentMessage({ originChannelId: "channel-private", originMessageId: "asked-1" }), [home]);
  assert.equal(origin.channelName, undefined);
  assert.equal(origin.href, undefined);
  assert.equal(messageLinkOriginLabel(origin), "from a private Channel");
  assert.doesNotMatch(messageLinkOriginTitle(origin), /channel-private/u);
});

test("only an Agent written outside its own Channel is a link", () => {
  assert.equal(messageLinkOrigin(agentMessage({}), [home]), undefined);
  assert.equal(messageLinkOrigin(agentMessage({ originChannelId: "channel-away" }), [home]), undefined);
  // A Human or system snapshot claiming an origin is not an Agent link.
  assert.equal(messageLinkOrigin({ ...agentMessage({ originChannelId: "channel-home" }),
    from: { kind: "user", label: "alice", userId: "u", email: "", originChannelId: "channel-home" } }, [home]),
  undefined);
});

test("a relayed reply points back at the Channel the reply was written in and says who answered", () => {
  const origin = messageLinkOrigin({
    messageId: "link-reply:reply-9", channelId: "channel-home", body: "yes, confirmed", sentAt: "",
    from: { kind: "user", label: "claude:2", userId: "owner-1", email: "" },
    metadata: { xmatrixProvenance: "cross_channel_reply",
      crossChannelReply: { sourceChannelId: "channel-away", sourceMessageId: "reply-9", linkMessageId: "link-1",
        replierKind: "agent" } },
  }, [home, { id: "channel-away", spaceId: "space-1", name: "infra" }]);
  assert.equal(origin.kind, "reply");
  assert.equal(origin.replierKind, "agent");
  assert.equal(messageLinkOriginLabel(origin), "reply from #infra");
  assert.match(origin.href, /#message:reply-9$/u);
});
