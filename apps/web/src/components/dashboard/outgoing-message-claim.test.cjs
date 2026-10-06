const assert = require("node:assert/strict");
const test = require("node:test");

async function load() {
  return await import("./outgoing-message-claim.ts");
}

const row = (over) => ({
  clientMessageId: "c1",
  channelId: "ch-1",
  body: "ok",
  attachments: [],
  sentAt: "2026-08-18T00:00:00.000Z",
  status: "pending",
  ...over,
});

test("a committed message retires the row whose clientMessageId it carries", async () => {
  // A human HTTP append persists clientMessageId as the durable messageId, so
  // the committed message identifies its own row exactly.
  const { matchClaimableOutgoing } = await load();
  assert.equal(
    matchClaimableOutgoing(
      { messageId: "timed-out", channelId: "ch-1", body: "ok", sentAt: "2026-08-18T00:00:01.000Z" },
      [row({ clientMessageId: "timed-out", status: "unconfirmed" })],
    ),
    "timed-out",
  );
});

test("exact identity wins over a same-bodied pending row that looks closer in time", async () => {
  const { matchClaimableOutgoing } = await load();
  // The echo belongs to the unconfirmed row, but the pending row's local time
  // is nearer. Running the content heuristic first would let `pending` steal it.
  const claimed = matchClaimableOutgoing(
    { messageId: "first", channelId: "ch-1", body: "ok", sentAt: "2026-08-18T00:00:11.000Z" },
    [
      row({ clientMessageId: "first", status: "unconfirmed", sentAt: "2026-08-18T00:00:00.000Z" }),
      row({ clientMessageId: "second", status: "pending", sentAt: "2026-08-18T00:00:10.000Z" }),
    ],
  );
  assert.equal(claimed, "first", "the row named by the committed messageId is the one retired");
});

test("each repeated-body send is retired by its own messageId, not by order or time", async () => {
  const { matchClaimableOutgoing } = await load();
  const rows = [
    row({ clientMessageId: "first", status: "unconfirmed", sentAt: "2026-08-18T00:00:00.000Z" }),
    row({ clientMessageId: "second", status: "unconfirmed", sentAt: "2026-08-18T00:00:10.000Z" }),
  ];
  // Deliberately commit them out of send order and with unhelpful timestamps.
  assert.equal(
    matchClaimableOutgoing(
      { messageId: "second", channelId: "ch-1", body: "ok", sentAt: "2026-08-18T00:00:00.500Z" },
      rows,
    ),
    "second",
  );
  assert.equal(
    matchClaimableOutgoing(
      { messageId: "first", channelId: "ch-1", body: "ok", sentAt: "2026-08-18T00:00:20.000Z" },
      rows,
    ),
    "first",
  );
});

test("an unconfirmed row is never retired by the content heuristic alone", async () => {
  const { matchClaimableOutgoing } = await load();
  // Same channel, same body, plausible time — but the committed messageId
  // belongs to neither row. An unknown result must stay unknown.
  assert.equal(
    matchClaimableOutgoing(
      { messageId: "someone-else", channelId: "ch-1", body: "ok", sentAt: "2026-08-18T00:00:01.000Z" },
      [row({ clientMessageId: "mine", status: "unconfirmed" })],
    ),
    undefined,
  );
});

test("a failed row is not retired even by its own messageId", async () => {
  const { matchClaimableOutgoing } = await load();
  assert.equal(
    matchClaimableOutgoing(
      { messageId: "gone", channelId: "ch-1", body: "ok", sentAt: "2026-08-18T00:00:01.000Z" },
      [row({ clientMessageId: "gone", status: "failed" })],
    ),
    undefined,
  );
});

test("the legacy pending fallback still resolves a lone same-bodied row", async () => {
  const { matchClaimableOutgoing } = await load();
  assert.equal(
    matchClaimableOutgoing(
      { messageId: "server-assigned", channelId: "ch-1", body: "ok", sentAt: "2026-08-18T00:00:01.000Z" },
      [row({ clientMessageId: "legacy", status: "pending" })],
    ),
    "legacy",
  );
});

test("another channel's rows are never claimed", async () => {
  const { matchClaimableOutgoing } = await load();
  assert.equal(
    matchClaimableOutgoing(
      { messageId: "mine", channelId: "ch-2", body: "ok", sentAt: "2026-08-18T00:00:01.000Z" },
      [row({ clientMessageId: "mine" })],
    ),
    undefined,
  );
});
