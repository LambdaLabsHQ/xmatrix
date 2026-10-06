const assert = require("node:assert/strict");

const test = require("node:test");
require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const {
  PRODUCT_TAIL_CACHE_CHANNEL_MESSAGE_LIMIT,
  buildProductTailCacheEntry,
  decideProductTailCacheAdmission,
  planProductTailCacheEviction,
} = require("./product-tail-cache.ts");

const message = (sequence, extra = {}) => ({
  messageId: `m${sequence}`,
  sequence,
  body: `body ${sequence}`,
  ...extra,
});

const build = (overrides = {}) =>
  buildProductTailCacheEntry({
    userId: "user-1",
    channelId: "c1",
    hasOlderMessages: false,
    cachedAt: 1000,
    contentRevision: 12,
    messages: [message(3), message(4)],
    ...overrides,
  });

test("build keeps only sequenced rows, strips volatile attachment locators, and bounds the window", () => {
  const built = build({
    messages: [
      message(4, {
        attachments: [{
          id: "a1", kind: "image", name: "x.png", mimeType: "image/png", size: 10,
          contentHash: "h", dataUrl: "data:image/png;base64,xx", url: "https://leak",
          objectKey: "objects/leak", thumbnailUrl: "blob:leak",
        }],
      }),
      { messageId: "pending", body: "optimistic send" },
      message(1),
      message(3),
      message(3),
    ],
  });
  assert.deepEqual(
    built.messages.map((m) => m.sequence),
    [1, 3, 4],
    "unsequenced optimistic sends drop; dedupe keeps one seq 3",
  );
  assert.equal(built.tailSequence, 4);
  const attachment = built.messages[2].attachments[0];
  assert.deepEqual(
    Object.keys(attachment).sort(),
    ["contentHash", "id", "kind", "mimeType", "name", "size"],
  );
  assert.equal(built.appliedContentRevision, 12);
  assert.ok(built.encodedBytes > 0);

  const wide = build({
    messages: Array.from({ length: 150 }, (_, index) => message(index + 2)),
  });
  assert.equal(wide.messages.length, PRODUCT_TAIL_CACHE_CHANNEL_MESSAGE_LIMIT);
  assert.equal(wide.hasOlderMessages, true, "a budget-trimmed tail must not claim completeness");
});

test("build persists nothing without a valid applied contentRevision", () => {
  assert.equal(build({ contentRevision: undefined }), null);
  assert.equal(build({ contentRevision: -1 }), null);
  assert.equal(build({ contentRevision: 3.5 }), null);
  // A revision-0 stamp (a channel whose served bytes never changed) is a real
  // stamp, not absence.
  assert.equal(build({ contentRevision: 0 }).appliedContentRevision, 0);
});

test("admission opens only on an exact contentRevision match and non-regressed head", () => {
  const entry = build({ hasOlderMessages: true });
  const binding = { channelId: "c1", historyHeadSequence: 9, contentRevision: 12 };

  const open = decideProductTailCacheAdmission(entry, binding, "user-1");
  assert.equal(open.decision, "open");
  assert.equal(open.revalidateAfterSequence, 4, "tail behind head gap-fills via afterSequence");
  assert.equal(
    decideProductTailCacheAdmission(entry, { ...binding, historyHeadSequence: 4 }, "user-1")
      .revalidateAfterSequence,
    4,
    "a fresh window still revalidates its tail (an empty page confirms it)",
  );

  assert.deepEqual(
    decideProductTailCacheAdmission(entry, { ...binding, contentRevision: 13 }, "user-1"),
    { decision: "purge", reason: "content_revision_moved" },
    "a moved revision means served bytes changed; afterSequence cannot repair them",
  );
  assert.deepEqual(
    decideProductTailCacheAdmission(entry, { ...binding, contentRevision: 11 }, "user-1"),
    { decision: "purge", reason: "content_revision_regressed" },
  );
  assert.deepEqual(
    decideProductTailCacheAdmission(entry, { ...binding, contentRevision: undefined }, "user-1"),
    { decision: "closed", reason: "content_revision_unknown" },
    "an older Hub without the catalog watermark keeps the cache invisible, not destroyed",
  );
  assert.deepEqual(
    decideProductTailCacheAdmission(entry, binding, "user-2"),
    { decision: "purge", reason: "user_mismatch" },
  );
  assert.deepEqual(
    decideProductTailCacheAdmission(entry, { ...binding, channelId: "c2" }, "user-1"),
    { decision: "purge", reason: "channel_binding_changed" },
  );
  assert.deepEqual(
    decideProductTailCacheAdmission(entry, { ...binding, historyHeadSequence: undefined }, "user-1"),
    { decision: "closed", reason: "head_unknown" },
    "an omitted head watermark keeps the cache invisible without destroying it",
  );
  assert.deepEqual(
    decideProductTailCacheAdmission(entry, { ...binding, historyHeadSequence: 3 }, "user-1"),
    { decision: "purge", reason: "head_regressed" },
  );
  assert.deepEqual(
    decideProductTailCacheAdmission({ ...entry, schemaVersion: 1 }, binding, "user-1"),
    { decision: "purge", reason: "schema_version" },
    "pre-revision schema entries never render",
  );
});

test("an offline edit of an old sequence never renders from cache: head unchanged, revision advanced", () => {
  // Cache holds body A at sequence 5. While the app was dead, that message was
  // edited to body B: historyHeadSequence stays 5, contentRevision advances.
  // afterSequence=5 would return 0 rows, so admission must destroy the entry —
  // never open-and-gap-fill stale bytes.
  const entry = build({
    messages: [message(4), { ...message(5), body: "body A (stale)" }],
  });
  const binding = { channelId: "c1", historyHeadSequence: 5, contentRevision: 13 };
  const admission = decideProductTailCacheAdmission(entry, binding, "user-1");
  assert.deepEqual(admission, { decision: "purge", reason: "content_revision_moved" });
  assert.equal(admission.entry, undefined, "a purge decision must expose no renderable rows");
  // The same window under the unmoved revision opens and revalidates its tail.
  assert.deepEqual(
    decideProductTailCacheAdmission(entry, { ...binding, contentRevision: 12 }, "user-1"),
    { decision: "open", entry, revalidateAfterSequence: 5 },
  );
});

test("a tampered or unordered window purges instead of rendering", () => {
  const entry = build({ messages: [message(3), message(4), message(5)] });
  const tampered = { ...entry, messages: [entry.messages[1], entry.messages[0], entry.messages[2]] };
  assert.deepEqual(
    decideProductTailCacheAdmission(
      tampered,
      { channelId: "c1", historyHeadSequence: 5, contentRevision: 12 },
      "user-1",
    ),
    { decision: "purge", reason: "inconsistent_window" },
  );
});

test("eviction plan removes least-recently-accessed channels until the budget fits", () => {
  const plan = planProductTailCacheEviction(
    [
      { channelId: "hot", encodedBytes: 400, lastAccessAt: 300 },
      { channelId: "cold", encodedBytes: 500, lastAccessAt: 100 },
      { channelId: "warm", encodedBytes: 300, lastAccessAt: 200 },
    ],
    800,
  );
  assert.deepEqual(plan, ["cold"]);
  assert.deepEqual(planProductTailCacheEviction([], 800), []);
  assert.deepEqual(
    planProductTailCacheEviction([{ channelId: "only", encodedBytes: 100, lastAccessAt: 1 }], 800),
    [],
  );
});
