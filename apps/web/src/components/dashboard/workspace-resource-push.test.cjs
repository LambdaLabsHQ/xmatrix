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
    for (const queryKey of [space, other, page, transfers, wide, pending, grant]) {
      client.setQueryData(queryKey, { ok: true });
    }
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
    client.clear();
  } finally {
    push.setHumanPushConnected(false);
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
