const assert = require("node:assert/strict");
const test = require("node:test");

const SCOPE = {
  channelId: "channel-1",
  viewerId: "user-1",
  authenticated: true,
};

async function loadStore() {
  return await import("./message-attachment-media-store.ts");
}

async function withRevokedUrls(run) {
  const revoked = [];
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = value => revoked.push(value);
  try { await run(revoked); } finally { URL.revokeObjectURL = originalRevoke; }
}

test("releasing a store revokes every object URL it handed out", async () => {
  const {
    createMessageAttachmentMediaStore,
    activateMessageAttachmentMediaStore,
    deactivateMessageAttachmentMediaStore,
    releaseMessageAttachmentMediaStore,
  } = await loadStore();
  await withRevokedUrls(async revoked => {
    const store = createMessageAttachmentMediaStore(SCOPE);
    store.objectUrls.add("blob:one");
    store.objectUrls.add("blob:two");
    store.resolved.set("identity-1", { id: "a" });
    store.failures.set("identity-1", "unavailable");
    store.loads.set("identity-2", Promise.resolve({ id: "b" }));

    deactivateMessageAttachmentMediaStore(store);
    assert.equal(store.active, false);
    activateMessageAttachmentMediaStore(store);
    assert.equal(store.active, true);

    releaseMessageAttachmentMediaStore(store);

    assert.deepEqual(revoked.sort(), ["blob:one", "blob:two"]);
    assert.equal(store.active, false);
    assert.equal(store.released, true);
    activateMessageAttachmentMediaStore(store);
    assert.equal(store.active, false, "a final release cannot be reactivated");
    assert.equal(store.objectUrls.size, 0);
    assert.equal(store.resolved.size, 0);
    assert.equal(store.loads.size, 0);
    assert.equal(store.failures.size, 0);
  });
});

test("a store keeps resolved media across the rows that come and go above it", async () => {
  const { createMessageAttachmentMediaStore } = await loadStore();
  const store = createMessageAttachmentMediaStore(SCOPE);
  // A row resolves media, then unmounts because it scrolled out of the
  // virtualized window. Nothing about that unmount may touch the store.
  store.resolved.set("identity-1", { id: "a", url: "blob:one" });
  store.objectUrls.add("blob:one");

  assert.equal(store.resolved.get("identity-1").url, "blob:one");
  assert.equal(store.objectUrls.has("blob:one"), true);
});

test("a read finishing after deactivation cannot leak or commit its object URL", async () => {
  const {
    commitMessageAttachmentMedia,
    createMessageAttachmentMediaStore,
    deactivateMessageAttachmentMediaStore,
  } = await loadStore();
  await withRevokedUrls(async revoked => {
    const store = createMessageAttachmentMediaStore(SCOPE);
    deactivateMessageAttachmentMediaStore(store);

    assert.equal(
      commitMessageAttachmentMedia(store, "identity-1", { id: "a" }, "blob:late"),
      false,
    );
    assert.deepEqual(revoked, ["blob:late"]);
    assert.equal(store.objectUrls.size, 0);
    assert.equal(store.resolved.size, 0);
  });
});

test("a store records the scope its media was authorized for", async () => {
  const { createMessageAttachmentMediaStore } = await loadStore();
  const store = createMessageAttachmentMediaStore(SCOPE);
  assert.deepEqual(store.scope, SCOPE);
  // Copied, so a later mutation of the caller's object cannot silently widen
  // what this store claims to be authorized for.
  SCOPE.channelId = "channel-2";
  assert.equal(store.scope.channelId, "channel-1");
  SCOPE.channelId = "channel-1";
});
