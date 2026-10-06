const assert = require("node:assert/strict");
const test = require("node:test");

async function load() {
  return await import("./reconcile-unconfirmed-send.ts");
}

test("the same session reconciles; a changed token refuses the write-back", async () => {
  const { reconcileAuthorityIsCurrent } = await load();
  assert.equal(reconcileAuthorityIsCurrent("token-1", "token-1"), true);
  assert.equal(
    reconcileAuthorityIsCurrent("token-1", "token-2"),
    false,
    "a rotated or re-logged-in session is a different authorization context",
  );
});

test("a probe with no token is never allowed to write back", async () => {
  const { reconcileAuthorityIsCurrent } = await load();
  assert.equal(
    reconcileAuthorityIsCurrent(null, null),
    false,
  );
});

function probeDeps(over) {
  return {
    clientMessageId: "mine",
    delaysMs: [0, 0, 0],
    wait: async () => {},
    authorityIsCurrent: () => true,
    isStillOutstanding: () => true,
    fetchPage: async () => ({ messages: [{ messageId: "mine" }] }),
    commitCommitted: () => {},
    ...over,
  };
}

test("finding the committed message retires exactly that row", async () => {
  const { runUnconfirmedSendReconcile } = await load();
  const committedWith = [];
  const outcome = await runUnconfirmedSendReconcile(probeDeps({
    fetchPage: async () => ({
      messages: [{ messageId: "someone-else" }, { messageId: "mine" }],
    }),
    commitCommitted: (entry) => committedWith.push(entry.messageId),
  }));
  assert.equal(outcome, "reconciled");
  assert.deepEqual(committedWith, ["mine"], "only the named message may be committed");
});

test("not finding it leaves the row alone", async () => {
  const { runUnconfirmedSendReconcile } = await load();
  let commits = 0;
  const outcome = await runUnconfirmedSendReconcile(probeDeps({
    fetchPage: async () => ({ messages: [{ messageId: "unrelated" }] }),
    commitCommitted: () => { commits += 1; },
  }));
  assert.equal(outcome, "not-found");
  assert.equal(commits, 0, "an unresolved row is never retired on a guess");
});

test("a timed-out probe keeps trying and then stops", async () => {
  const { runUnconfirmedSendReconcile } = await load();
  let attempts = 0;
  const outcome = await runUnconfirmedSendReconcile(probeDeps({
    delaysMs: [0, 0],
    fetchPage: async () => {
      attempts += 1;
      throw new Error("probe deadline");
    },
  }));
  assert.equal(outcome, "not-found");
  assert.equal(attempts, 2, "it retries the bounded number of times, then gives up");
});

test("authority lost while the page is in flight must not commit", async () => {
  const { runUnconfirmedSendReconcile } = await load();
  let commits = 0;
  let live = true;
  const outcome = await runUnconfirmedSendReconcile(probeDeps({
    authorityIsCurrent: () => live,
    // The revoke lands during the fetch, after the pre-check passed.
    fetchPage: async () => {
      live = false;
      return { messages: [{ messageId: "mine" }] };
    },
    commitCommitted: () => { commits += 1; },
  }));
  assert.equal(outcome, "authority-lost");
  assert.equal(commits, 0, "a stale read must never write history back");
});

test("a row already retired by the live echo ends the probe", async () => {
  const { runUnconfirmedSendReconcile } = await load();
  let fetches = 0;
  const outcome = await runUnconfirmedSendReconcile(probeDeps({
    isStillOutstanding: () => false,
    fetchPage: async () => { fetches += 1; return { messages: [] }; },
  }));
  assert.equal(outcome, "already-resolved");
  assert.equal(fetches, 0, "no probe is issued once the row is gone");
});

test("a reconnect retries every still-unconfirmed row with a live channel", async () => {
  const { reconnectableUnconfirmedSends } = await load();
  const selected = reconnectableUnconfirmedSends(
    [
      { clientMessageId: "retry-1", channelId: "channel-1", status: "unconfirmed" },
      { clientMessageId: "pending", channelId: "channel-1", status: "pending" },
      { clientMessageId: "missing-channel", channelId: "channel-2", status: "unconfirmed" },
    ],
    [{ id: "channel-1", name: "Live" }],
  );
  assert.deepEqual(
    selected.map(({ outgoing, channel }) => [outgoing.clientMessageId, channel.id]),
    [["retry-1", "channel-1"]],
  );
});

test("a snapshot and a live read that resolve the same way do not read as rotation", async () => {
  const { reconcileAuthorityIsCurrent } = await load();
  // The production fence resolves both sides through the same expression. If
  // capture fell back to a prop while the live read fell back to null, the
  // window before the ref syncs would look like a token change and silently
  // disable every reconcile.
  const resolve = (ref, prop) => ref ?? prop ?? null;
  const captured = resolve(null, "prop-token");
  assert.equal(
    reconcileAuthorityIsCurrent(captured, resolve(null, "prop-token")),
    true,
    "an unsynced ref must not be mistaken for a rotated session",
  );
  // A genuine rotation still has to be caught.
  assert.equal(
    reconcileAuthorityIsCurrent(captured, resolve("rotated", "prop-token")),
    false,
  );
});

test("committing a reconciled message claims, merges, then removes that row", async () => {
  const { commitReconciledOutgoing } = await load();
  const calls = [];
  const retired = commitReconciledOutgoing({
    committed: { messageId: "mine" },
    outgoing: [{ clientMessageId: "mine" }, { clientMessageId: "other" }],
    claim: (committed) => { calls.push(`claim:${committed.messageId}`); return "mine"; },
    merge: (committed) => { calls.push(`merge:${committed.messageId}`); },
    remove: (id) => { calls.push(`remove:${id}`); },
  });
  assert.equal(retired, true);
  assert.deepEqual(
    calls,
    ["claim:mine", "merge:mine", "remove:mine"],
    "merging alone retires nothing — the remove must actually happen",
  );
});

test("an unclaimed canonical message is merged but removes nothing", async () => {
  const { commitReconciledOutgoing } = await load();
  const calls = [];
  const retired = commitReconciledOutgoing({
    committed: { messageId: "unowned" },
    outgoing: [{ clientMessageId: "mine" }],
    claim: () => undefined,
    merge: (committed) => { calls.push(`merge:${committed.messageId}`); },
    remove: (id) => { calls.push(`remove:${id}`); },
  });
  assert.equal(retired, false);
  assert.deepEqual(calls, ["merge:unowned"], "no row may be retired without a claim");
});

test("the production reconciler binds the authority fence, bounded fetch and commit", async () => {
  const { createUnconfirmedSendReconciler } = await load();
  const calls = [];
  const reconcile = createUnconfirmedSendReconciler({
    delaysMs: [0],
    probeDeadlineMs: 50,
    currentToken: () => "token-1",
    isStillOutstanding: (id) => id === "mine",
    fetchPage: async (token, channelId, signal) => {
      calls.push(`fetch:${token}:${channelId}:${signal.aborted}`);
      return { messages: [{ messageId: "mine" }] };
    },
    commitCommitted: (message, channelId) => {
      calls.push(`commit:${message.messageId}:${channelId}`);
    },
    wait: async () => {},
  });

  assert.equal(await reconcile("channel-1", "mine"), "reconciled");
  assert.deepEqual(calls, ["fetch:token-1:channel-1:false", "commit:mine:channel-1"]);
});
