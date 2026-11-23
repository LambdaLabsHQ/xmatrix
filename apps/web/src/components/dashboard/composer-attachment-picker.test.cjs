const assert = require("node:assert/strict");
const test = require("node:test");

require("./typescript-require.cjs").installTypeScriptRequire();
const {
  attachmentPanelKey,
  clearPendingAttachmentSource,
  getActiveNativeAttachmentPanel,
  isDraftPickCurrent,
  openNativeAttachmentPanel,
  subscribeNativeAttachmentPanel,
} = require("./composer-attachment-picker.ts");

test.afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
});

test("attachment panel keyboard navigation wraps across sources and picks on Enter", () => {
  assert.equal(attachmentPanelKey({ open: false, active: 0, key: "Escape" }), null);
  assert.deepEqual(attachmentPanelKey({ open: true, active: -1, key: "ArrowDown" }), { active: 0 });
  assert.deepEqual(attachmentPanelKey({ open: true, active: -1, key: "ArrowUp" }), { active: 2 });
  assert.equal(attachmentPanelKey({ open: true, active: -1, key: "Enter" }), null);
  assert.deepEqual(attachmentPanelKey({ open: true, active: 0, key: "ArrowDown" }), { active: 1 });
  assert.deepEqual(attachmentPanelKey({ open: true, active: 2, key: "ArrowDown" }), { active: 0 });
  assert.deepEqual(attachmentPanelKey({ open: true, active: 0, key: "ArrowUp" }), { active: 2 });
  assert.deepEqual(attachmentPanelKey({ open: true, active: 1, key: "Enter" }), { active: null, pick: "camera" });
  assert.deepEqual(attachmentPanelKey({ open: true, active: 1, key: "Escape" }), { active: null });
  assert.equal(attachmentPanelKey({ open: true, active: 0, key: "a" }), null);
});

test("clearPendingAttachmentSource resets any armed source record", () => {
  globalThis.window = { __xmatrixPendingAttachmentSource: { source: "photos", expiresAt: Date.now() + 5000 } };
  clearPendingAttachmentSource();
  assert.equal(globalThis.window.__xmatrixPendingAttachmentSource, null);
});

test("draft pick ownership rejects A->B, A->B->A, same-channel sends, wrong owner, and unmounted drafts", () => {
  const origin = { ownerId: "c1", generation: 3, draftRevision: 1, scope: "channel-a" };
  assert.equal(isDraftPickCurrent(origin, { ownerId: "c1", mounted: true, generation: 3, draftRevision: 1, scope: "channel-a" }), true);
  // Different composer instance.
  assert.equal(isDraftPickCurrent(origin, { ownerId: "c2", mounted: true, generation: 3, draftRevision: 1, scope: "channel-a" }), false);
  // Switched to channel B (scope changed + generation bumped).
  assert.equal(isDraftPickCurrent(origin, { ownerId: "c1", mounted: true, generation: 4, draftRevision: 1, scope: "channel-b" }), false);
  // Switched A -> B -> A (same scope, generation bumped).
  assert.equal(isDraftPickCurrent(origin, { ownerId: "c1", mounted: true, generation: 5, draftRevision: 1, scope: "channel-a" }), false);
  // Draft sent in the same channel while iCloud media was still downloading.
  assert.equal(isDraftPickCurrent(origin, { ownerId: "c1", mounted: true, generation: 3, draftRevision: 2, scope: "channel-a" }), false);
  // Composer/thread closed.
  assert.equal(isDraftPickCurrent(origin, { ownerId: "c1", mounted: false, generation: 3, draftRevision: 1, scope: "channel-a" }), false);
  // Direct drop/setInputFiles with no pending click origin stays allowed when not required,
  // while native open-panel mode rejects any orphan change missing an origin.
  assert.equal(isDraftPickCurrent(null, { ownerId: "c1", mounted: true, generation: 3, draftRevision: 1, scope: "channel-a" }), true);
  assert.equal(isDraftPickCurrent(null, { ownerId: "c1", mounted: true, generation: 3, draftRevision: 1, scope: "channel-a", requireOrigin: true }), false);
  assert.equal(isDraftPickCurrent(null, { ownerId: "c1", mounted: false, generation: 3, draftRevision: 1, scope: "channel-a" }), false);
});

test("page-wide native attachment panel serializes across composers and settles even after the opener unmounts", () => {
  const listeners = new Map();
  let clickCount = 0;
  const fakeInput = {
    type: "",
    multiple: false,
    tabIndex: 0,
    style: {},
    isConnected: false,
    files: null,
    value: "",
    setAttribute() {},
    addEventListener(name, fn) {
      listeners.set(name, fn);
    },
    click() {
      clickCount += 1;
    },
  };
  globalThis.window = {};
  globalThis.document = {
    body: {
      appendChild(node) {
        node.isConnected = true;
      },
    },
    createElement() {
      return fakeInput;
    },
  };

  let notifications = 0;
  const unsubscribe = subscribeNativeAttachmentPanel(() => {
    notifications += 1;
  });

  const delivered = [];
  const firstOrigin = { ownerId: "new-conv", generation: 0, draftRevision: 0, scope: "new-conversation" };
  const secondOrigin = { ownerId: "channel-comp", generation: 0, draftRevision: 0, scope: "channel-b" };

  assert.equal(
    openNativeAttachmentPanel({
      source: "photos",
      origin: firstOrigin,
      deliver: (files, origin) => delivered.push({ files, origin }),
    }),
    true
  );
  assert.equal(clickCount, 1);
  assert.deepEqual(getActiveNativeAttachmentPanel(), firstOrigin);
  assert.equal(globalThis.window.__xmatrixPendingAttachmentSource.source, "photos");

  // Second composer cannot overwrite or open a concurrent panel while the first is in flight.
  assert.equal(
    openNativeAttachmentPanel({
      source: "files",
      origin: secondOrigin,
      deliver: () => {
        throw new Error("second composer must not run");
      },
    }),
    false
  );
  assert.equal(clickCount, 1);
  assert.deepEqual(getActiveNativeAttachmentPanel(), firstOrigin);

  // When the first panel settles (even after New Conversation unmounted), the
  // page-wide lock clears so the second composer can open its own panel next.
  fakeInput.files = [{ name: "icloud.mov" }];
  listeners.get("change")();
  assert.equal(getActiveNativeAttachmentPanel(), null);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].origin, firstOrigin);

  // Second composer can now open and settle via cancel.
  assert.equal(
    openNativeAttachmentPanel({
      source: "files",
      origin: secondOrigin,
      deliver: () => {
        throw new Error("cancel must not deliver");
      },
    }),
    true
  );
  assert.equal(clickCount, 2);
  listeners.get("cancel")();
  assert.equal(getActiveNativeAttachmentPanel(), null);
  assert.ok(notifications >= 4);
  unsubscribe();
});
