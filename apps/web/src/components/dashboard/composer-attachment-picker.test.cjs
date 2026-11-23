const assert = require("node:assert/strict");
const test = require("node:test");

require("./typescript-require.cjs").installTypeScriptRequire();
const {
  PENDING_ATTACHMENT_SOURCE_TTL_MS,
  armNativeAttachmentSource,
  attachmentPanelKey,
  clearPendingAttachmentSource,
  consumePendingAttachmentSource,
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

test("armed attachment source is one-shot, expires cleanly, and does not leak to other file inputs", () => {
  globalThis.window = {};
  armNativeAttachmentSource("photos", 1000);
  assert.equal(consumePendingAttachmentSource(1000 + 50), "photos");
  // Second consume (e.g. avatar file input) sees null.
  assert.equal(consumePendingAttachmentSource(1000 + 60), null);

  // Expired source is ignored.
  armNativeAttachmentSource("camera", 2000);
  assert.equal(consumePendingAttachmentSource(2000 + PENDING_ATTACHMENT_SOURCE_TTL_MS + 1), null);

  // Explicit clear drops armed state.
  armNativeAttachmentSource("files", 3000);
  clearPendingAttachmentSource();
  assert.equal(consumePendingAttachmentSource(3000 + 10), null);
});

test("draft pick ownership rejects A->B, A->B->A generation bumps, and unmounted drafts", () => {
  const origin = { generation: 3, scope: "channel-a" };
  assert.equal(isDraftPickCurrent(origin, { mounted: true, generation: 3, scope: "channel-a" }), true);
  // Switched to channel B (scope changed + generation bumped).
  assert.equal(isDraftPickCurrent(origin, { mounted: true, generation: 4, scope: "channel-b" }), false);
  // Switched A -> B -> A (same scope, generation bumped).
  assert.equal(isDraftPickCurrent(origin, { mounted: true, generation: 5, scope: "channel-a" }), false);
  // Composer/thread closed.
  assert.equal(isDraftPickCurrent(origin, { mounted: false, generation: 3, scope: "channel-a" }), false);
  // Direct drop/setInputFiles with no pending click origin stays allowed while mounted.
  assert.equal(isDraftPickCurrent(null, { mounted: true, generation: 3, scope: "channel-a" }), true);
  assert.equal(isDraftPickCurrent(null, { mounted: false, generation: 3, scope: "channel-a" }), false);
});
