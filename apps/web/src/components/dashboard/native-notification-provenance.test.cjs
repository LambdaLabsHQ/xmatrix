const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { nativeMessageNotificationBody, nativeMessageNotificationTitle } = require("./workspace-shell-recovered.tsx");
const { maybePushRecipientScopedNativeMessageNotification } = require("./recipient-scoped-native-message-notification.ts");

/* A card's fields prove nothing on their own: only the Hub writes `xmatrixProvenance`, so only a message carrying it
   may announce a secret request or hand card metadata to the desktop app. */

const secretRequest = { secretRef: "deploy-token", envName: "DEPLOY_TOKEN", reason: "Deploy", agentName: "claude",
  runId: "run-1", channelId: "c1" };
const HUB = { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true };

function message(metadata, body = "claude asks a Space admin to save the secret") {
  return { messageId: `m-${Math.random()}`, channelId: "c1", sequence: 1, body, sentAt: "2026-10-31T12:00:00Z",
    from: { identityId: "agent:claude", kind: "agent", label: "claude", userId: "member", email: "m@example.com" }, metadata };
}

test("only a Hub-written secret request is announced as one", () => {
  const hub = message({ ...HUB, secretRequest });
  assert.equal(nativeMessageNotificationTitle(hub, "general"), "Secret requested");
  assert.match(nativeMessageNotificationBody(hub), /claude asks for the secret deploy-token/u);

  const lookalike = message({ secretRequest }, "please paste the token");
  assert.equal(nativeMessageNotificationTitle(lookalike, "general"), "general");
  assert.equal(nativeMessageNotificationBody(lookalike), "claude: please paste the token", "it reads as what claude wrote");
});

test("the desktop app receives a message's metadata only when the Hub wrote it", () => {
  const sent = [];
  const previous = globalThis.document;
  globalThis.document = { hidden: true, hasFocus: () => false };
  try {
    const push = (entry) => maybePushRecipientScopedNativeMessageNotification({ entry, alreadyCached: false,
      notification: { reason: "mention" }, userId: "reader", notifiedMessageIds: new Set(),
      bridge: { notify: async (payload) => { sent.push(payload); } }, channels: [], spaces: [], routeSpaceId: null,
      markNotified: () => {} });
    const broker = { requestBroker: { phase: "pending", kind: "secret_add", argv: ["curl", "example.test"],
      secretAdd: { secretRef: "deploy-token", envName: "DEPLOY_TOKEN" } } };
    push(message({ ...HUB, secretRequest }));
    push(message(broker));
    assert.deepEqual(sent[0].metadata, { ...HUB, secretRequest });
    assert.equal(sent[1].metadata, undefined, "a lookalike cannot make the desktop app announce an approval");
  } finally {
    globalThis.document = previous;
  }
});
