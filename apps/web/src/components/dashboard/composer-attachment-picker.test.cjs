const assert = require("node:assert/strict");
const test = require("node:test");

require("./typescript-require.cjs").installTypeScriptRequire();
const {
  PENDING_ATTACHMENT_SOURCE_TTL_MS,
  armNativeAttachmentSource,
  attachmentPanelKey,
  clearPendingAttachmentSource,
  isDraftPickCurrent,
} = require("./composer-attachment-picker.ts");

test.afterEach(() => {
  delete globalThis.window;
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

test("armNativeAttachmentSource writes bounded TTL record and clearPendingAttachmentSource resets it", () => {
  globalThis.window = {};
  const armed = armNativeAttachmentSource("photos", 1000);
  assert.deepEqual(armed, { source: "photos", expiresAt: 1000 + PENDING_ATTACHMENT_SOURCE_TTL_MS });
  assert.deepEqual(globalThis.window.__xmatrixPendingAttachmentSource, armed);

  clearPendingAttachmentSource();
  assert.equal(globalThis.window.__xmatrixPendingAttachmentSource, null);
});

test("draft pick ownership rejects A->B, A->B->A, same-channel sends, and unmounted drafts", () => {
  const origin = { generation: 3, draftRevision: 1, scope: "channel-a" };
  assert.equal(isDraftPickCurrent(origin, { mounted: true, generation: 3, draftRevision: 1, scope: "channel-a" }), true);
  // Switched to channel B (scope changed + generation bumped).
  assert.equal(isDraftPickCurrent(origin, { mounted: true, generation: 4, draftRevision: 1, scope: "channel-b" }), false);
  // Switched A -> B -> A (same scope, generation bumped).
  assert.equal(isDraftPickCurrent(origin, { mounted: true, generation: 5, draftRevision: 1, scope: "channel-a" }), false);
  // Draft sent in the same channel while iCloud media was still downloading.
  assert.equal(isDraftPickCurrent(origin, { mounted: true, generation: 3, draftRevision: 2, scope: "channel-a" }), false);
  // Composer/thread closed.
  assert.equal(isDraftPickCurrent(origin, { mounted: false, generation: 3, draftRevision: 1, scope: "channel-a" }), false);
  // Direct drop/setInputFiles with no pending click origin stays allowed when not required,
  // while native open-panel mode rejects any orphan change missing an origin.
  assert.equal(isDraftPickCurrent(null, { mounted: true, generation: 3, draftRevision: 1, scope: "channel-a" }), true);
  assert.equal(isDraftPickCurrent(null, { mounted: true, generation: 3, draftRevision: 1, scope: "channel-a", requireOrigin: true }), false);
  assert.equal(isDraftPickCurrent(null, { mounted: false, generation: 3, draftRevision: 1, scope: "channel-a" }), false);
});
