const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { isXMatrixSystemNoticeMessage, messageRichMetadata, systemNoticeTone } = require("./workspace-shell-message-model.ts");

function noticeMessage(overrides = {}) {
  const { from, metadata, ...rest } = overrides;
  return {
    messageId: "system:machine-stop-result:abc",
    channelId: "channel-1",
    body: "Stopped @codex-legend on Devs-MacBook-Pro.local.",
    sentAt: "2026-08-04T11:50:00Z",
    from: {
      identityId: "user:owner-1",
      kind: "user",
      label: "xMatrix",
      userId: "owner-1",
      email: "owner@example.com",
      avatarUrl: "/brand/xmatrix-management-icon.png",
      ...from,
    },
    metadata: {
      xmatrixProvenance: "system_fact",
      xmatrixSystemNotice: true,
      ...metadata,
    },
    ...rest,
  };
}

test("history reads and live deliveries carry rich metadata under one name", () => {
  // The hub once returned appMetadata from GET /history and metadata on the
  // socket frame, so a reload silently dropped every metadata-driven surface.
  const message = noticeMessage();
  assert.equal(messageRichMetadata(message).xmatrixSystemNotice, true);
  assert.equal(isXMatrixSystemNoticeMessage(message), true);

  const legacyShape = noticeMessage();
  legacyShape.appMetadata = legacyShape.metadata;
  delete legacyShape.metadata;
  assert.equal(
    messageRichMetadata(legacyShape),
    undefined,
    "the storage-side name must not reach a client; the hub emits metadata"
  );

  const plain = noticeMessage();
  delete plain.metadata;
  assert.equal(messageRichMetadata(plain), undefined);
});

test("hub system notices written under the owner principal read as the xMatrix identity", () => {
  assert.equal(isXMatrixSystemNoticeMessage(noticeMessage()), true);
  assert.equal(
    isXMatrixSystemNoticeMessage(
      noticeMessage({ from: { label: "xMatrix machine request" } })
    ),
    true,
    "machine request notices use a labelled xMatrix sender snapshot"
  );
});

test("ordinary user messages keep their human identity", () => {
  assert.equal(
    isXMatrixSystemNoticeMessage(noticeMessage({ from: { label: "Yiming Hu" }, metadata: {} })),
    false
  );
  assert.equal(
    isXMatrixSystemNoticeMessage(
      noticeMessage({ from: { label: "Yiming Hu" } })
    ),
    false,
    "a system notice without the reserved sender label stays attributed to its sender"
  );
  assert.equal(
    isXMatrixSystemNoticeMessage(noticeMessage({ metadata: { xmatrixSystemNotice: undefined } })),
    false,
    "a user who names themselves xMatrix does not inherit the system identity"
  );
  assert.equal(
    isXMatrixSystemNoticeMessage(noticeMessage({ metadata: { xmatrixSystemNotice: "true" } })),
    false,
    "only the hub's boolean marker counts as a system notice"
  );
});

test("the reserved label match is exact rather than a prefix of an unrelated name", () => {
  assert.equal(
    isXMatrixSystemNoticeMessage(noticeMessage({ from: { label: "xMatrixFan" } })),
    false
  );
  assert.equal(isXMatrixSystemNoticeMessage(noticeMessage({ from: { label: " xmatrix " } })), true);
});

test("queued start notices are waiting, not ordinary system facts", () => {
  assert.equal(
    systemNoticeTone(
      "xMatrix could not start @codex yet: the daemon on Workstation has no live control session. The run is queued and will start when that daemon reconnects.",
    ),
    "warning",
  );
  assert.equal(
    systemNoticeTone("xMatrix could not start @codex: machine routing is incomplete."),
    "error",
  );
  assert.equal(
    systemNoticeTone(
      "Couldn't start @grok-daniel-windows on Workstation. management overlay unavailable: candidate generation 117309440 bytes exceeds quota 67108864",
    ),
    "error",
  );
  assert.equal(
    systemNoticeTone("Stopped @codex-legend on Devs-MacBook-Pro.local."),
    "fact",
  );
});
