const assert = require("node:assert/strict");
const test = require("node:test");

test("human push suppresses fallback polls and names the list to re-read", async () => {
  const { QueryClient } = require("@tanstack/react-query");
  const push = await import("./workspace-resource-push.ts");
  const previous = globalThis.document;
  globalThis.document = { hidden: false };
  push.setHumanPushConnected(false);
  try {
    assert.equal(push.refetchUnlessHumanPush(15_000), 15_000);
    push.setHumanPushConnected(true);
    push.setHumanPushConnected(true);
    assert.equal(push.refetchUnlessHumanPush(15_000), false);
    globalThis.document = { hidden: true };
    push.setHumanPushConnected(false);
    assert.equal(push.refetchUnlessHumanPush(15_000), false);

    globalThis.document = { hidden: false };
    const client = new QueryClient();
    const space = ["xmatrix", "hub", "user", "automations", "space-1"];
    const other = ["xmatrix", "hub", "user", "automations", "space-2"];
    const page = ["xmatrix", "hub", "user", "page-automations", "space-1", "page"];
    const transfers = ["channel-transfers", "user", "space-1", "channel-1"];
    const wide = ["channel-transfers", "user", "space-1", ""];
    const pending = ["channel-pending-cross-space-reads", "user", "channel-1"];
    const grant = ["cross-space-read-grant", "user", "space-1", "grant-1"];
    const approvals = ["connector-action-approvals", "user", "channel-1"];
    const elsewhere = ["connector-action-approvals", "user", "channel-2"];
    const held = [space, other, page, transfers, wide, pending, grant, approvals, elsewhere];
    // A query read again is fresh; one already invalidated does not report a second invalidation.
    const read = () => { for (const queryKey of held) client.setQueryData(queryKey, { ok: true }); };
    read();
    const fetched = [];
    client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action?.type === "invalidate") {
        fetched.push(event.query.queryKey);
      }
    });
    push.invalidateWorkspaceResources(client, {
      spaceId: "space-1", resource: "automations",
    });
    assert.deepEqual(fetched.map((key) => key[3] ?? key[0]).sort(), ["automations", "page-automations"]);
    fetched.length = 0;
    push.invalidateWorkspaceResources(client, {
      spaceId: "space-1", resource: "channel_transfers", channelId: "channel-1",
    });
    assert.equal(fetched.length, 2);
    fetched.length = 0;
    push.invalidateWorkspaceResources(client, {
      resource: "cross_space_reads", spaceId: "space-1", channelId: "channel-1",
    });
    assert.equal(fetched.length, 2);
    fetched.length = 0;
    push.invalidateWorkspaceResources(client, {
      resource: "connector_action_requests", spaceId: "space-1", channelId: "channel-1",
    });
    assert.deepEqual(fetched, [approvals]);

    // Every list the Hub announces is one this client holds and re-reads on its
    // frame: a list announced with no query here would be kept current by a timer.
    const { WORKSPACE_RESOURCE_KINDS } = require("@xmatrix/protocol");
    for (const resource of WORKSPACE_RESOURCE_KINDS) {
      read();
      fetched.length = 0;
      push.invalidateWorkspaceResources(client, { resource, spaceId: "space-1", channelId: "channel-1" });
      assert.ok(fetched.length > 0, `${resource} names no cached list`);
    }
    // A socket that just connected names no list: every announced one is read again.
    read();
    fetched.length = 0;
    push.invalidateWorkspaceResources(client);
    assert.equal(fetched.length, held.length);
    client.clear();
  } finally {
    push.setHumanPushConnected(false);
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
