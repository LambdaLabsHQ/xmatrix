import assert from "node:assert/strict";

/**
 * A max-one pool handing out a new client after each destroyed checkout.
 * `failures[n]` is what checkout n's first matching query throws. A placed
 * read answers with the admitted fence of `context.placement`.
 */
export function retryPool(failOn, failures, fence = { __xmatrix_fence_shard_id: "shard-0",
  __xmatrix_fence_placement_epoch: 2, __xmatrix_fence_state: "active", __xmatrix_fence_target_shard_id: null },
checkoutFailures = [], readRows) {
  const clients = [];
  const checkouts = [];
  let current = null;
  return {
    clients,
    checkouts,
    factory: () => ({
      async connect() {
        const failure = checkoutFailures[checkouts.length];
        checkouts.push(failure);
        if (failure) throw failure;
        if (current) return current;
        const index = clients.length;
        const client = {
          queries: [], releases: [],
          async query(input) {
            const text = typeof input === "string" ? input : input.text;
            assert.equal(client.releases.includes(true), false, "a destroyed checkout was reused");
            client.queries.push(text);
            if (failures[index] && failOn.test(text)) throw failures[index];
            const row = text.includes("__xmatrix_fence_shard_id")
              ? { ...fence, __xmatrix_read_row: true, id: index } : { id: index };
            const rows = readRows ?? [row];
            return { rows, rowCount: rows.length };
          },
          release(destroy) {
            client.releases.push(destroy);
            if (destroy) current = null;
          },
        };
        clients.push(client);
        current = client;
        return client;
      },
      async end() {},
    }),
  };
}

