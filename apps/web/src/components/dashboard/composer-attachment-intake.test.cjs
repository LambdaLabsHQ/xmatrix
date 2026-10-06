const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  attachmentIntakeCapacity,
  boundedConcurrency,
  createAttachmentSlotLedger,
  createAttachmentUploadRegistry,
  planAttachmentIntake,
} = require("./composer-attachment-intake.ts");

let idCounter = 0;

function plan(overrides = {}) {
  idCounter = 0;
  return planAttachmentIntake({
    candidates: [],
    attachmentsEnabled: true,
    draftCount: 0,
    pendingCount: 0,
    maxAttachments: 10,
    maxBytes: 64_000_000,
    maxBytesLabel: "64 MB",
    kindOf: (file) => (file.type?.startsWith("image/") ? "image" : "file"),
    nameOf: (kind) => (kind === "image" ? "image" : "attachment"),
    makeId: () => `id-${(idCounter += 1)}`,
    ...overrides,
  });
}

function candidate(name, size, extra = {}) {
  return { file: { name, size, type: extra.type || "application/pdf" }, ...extra };
}

test("every accepted file gets a row before anything can await", () => {
  const result = plan({
    candidates: [candidate("a.pdf", 10), candidate("b.png", 20, { type: "image/png" })],
  });

  assert.equal(result.error, null);
  assert.deepEqual(
    result.entries.map((entry) => [entry.id, entry.name, entry.kind, entry.rejection]),
    [
      ["id-1", "a.pdf", "file", null],
      ["id-2", "b.png", "image", null],
    ],
    "planning is synchronous and total: the caller can render rows with no await in between"
  );
});

test("a rejected file still gets a row that says why", () => {
  const result = plan({
    candidates: [
      candidate("photos", 0, { isDirectory: true }),
      candidate("empty.txt", 0),
      candidate("huge.mov", 99_000_000, { type: "video/quicktime" }),
    ],
  });

  assert.deepEqual(
    result.entries.map((entry) => entry.rejection),
    ["Folders can't be attached — zip it first.", "This file is empty.", "File must be 64 MB or smaller."],
    "a file that can never upload must explain itself on screen instead of vanishing"
  );
});

test("a dropped folder is named as a folder, not as an empty file", () => {
  const [entry] = plan({ candidates: [candidate("src", 0, { isDirectory: true })] }).entries;
  assert.match(entry.rejection, /Folders/, "the OS hands a folder over as a zero-byte file");
});

test("intake stops at the attachment ceiling and says so", () => {
  const result = plan({
    candidates: [candidate("a.pdf", 1), candidate("b.pdf", 1), candidate("c.pdf", 1)],
    maxAttachments: 4,
    draftCount: 1,
    pendingCount: 1,
  });

  assert.equal(result.entries.length, 2, "capacity counts committed drafts and in-flight rows alike");
  assert.equal(result.error, "Attach at most 4 files.");
});

test("a full composer accepts nothing and explains it", () => {
  const result = plan({ candidates: [candidate("a.pdf", 1)], maxAttachments: 2, draftCount: 2 });
  assert.deepEqual(result.entries, []);
  assert.equal(result.error, "Attach at most 2 files.");
});

test("intake before attachments are ready reports the thread, not silence", () => {
  const result = plan({ candidates: [candidate("a.pdf", 1)], attachmentsEnabled: false });
  assert.deepEqual(result.entries, []);
  assert.match(result.error, /Preparing the thread/);
});

test("an empty drop is a no-op rather than an error", () => {
  const result = plan({ candidates: [], attachmentsEnabled: false });
  assert.deepEqual(result.entries, []);
  assert.equal(result.error, null);
});

test("capacity never goes negative", () => {
  assert.equal(attachmentIntakeCapacity({ maxAttachments: 3, draftCount: 5, pendingCount: 2 }), 0);
});

/**
 * Models the composer: `rendered` is what React has committed, the ledger
 * covers intakes whose rows have not landed yet. Capacity must be read the same
 * way the composer reads it.
 */
let ledgerIdCounter = 0;

function intakeWithLedger(ledger, rendered, count, maxAttachments = 10) {
  ledger.reconcile(new Set(rendered));
  const result = plan({
    candidates: Array.from({ length: count }, (_, index) => candidate(`f${index}.pdf`, 10)),
    maxAttachments,
    pendingCount: rendered.length + ledger.reservedCount(),
    makeId: () => `ledger-${(ledgerIdCounter += 1)}`,
  });
  ledger.reserve(result.entries.map((entry) => entry.id));
  return result;
}

test("two intakes in the same tick cannot both take the same slots", () => {
  const ledger = createAttachmentSlotLedger();
  const rendered = []; // React has not committed anything yet

  const first = intakeWithLedger(ledger, rendered, 6);
  const second = intakeWithLedger(ledger, rendered, 6);

  assert.equal(first.entries.length, 6);
  assert.equal(
    second.entries.length,
    4,
    "the second intake must see the first one's reservation even though no render happened"
  );
  assert.equal(second.error, "Attach at most 10 files.");
});

test("a third intake before the render still respects the ceiling", () => {
  const ledger = createAttachmentSlotLedger();
  const rendered = [];

  const counts = [4, 4, 4].map((count) => intakeWithLedger(ledger, rendered, count).entries.length);

  assert.deepEqual(counts, [4, 4, 2]);
  assert.equal(ledger.reservedCount(), 10, "every accepted row is still reserved until it renders");
});

test("the intake after the render counts each row exactly once", () => {
  const ledger = createAttachmentSlotLedger();
  const first = intakeWithLedger(ledger, [], 6);

  // React commits: the rows the reservation stood for are now real.
  const rendered = first.entries.map((entry) => entry.id);
  const second = intakeWithLedger(ledger, rendered, 6);

  assert.equal(
    second.entries.length,
    4,
    "rendered rows plus reservations must not double-count the same six ids"
  );
  assert.equal(ledger.reservedCount(), 4, "only the not-yet-rendered intake stays reserved");
});

test("a row removed before it rendered gives its slot back", () => {
  const ledger = createAttachmentSlotLedger();
  const first = intakeWithLedger(ledger, [], 10);
  assert.equal(intakeWithLedger(ledger, [], 1).entries.length, 0, "the composer is full");

  for (const entry of first.entries.slice(0, 3)) ledger.settle(entry.id);

  assert.equal(
    intakeWithLedger(ledger, [], 5).entries.length,
    3,
    "settling a reservation that never rendered must release its slot"
  );
});

test("a queued task cancelled before it starts never becomes live", () => {
  const registry = createAttachmentUploadRegistry();
  const generation = registry.generation();
  registry.begin("a");

  registry.cancel("a"); // still waiting behind the concurrency gate: no request exists
  assert.equal(registry.isLive("a", generation), false);
});

test("a task cancelled while compressing never becomes live", () => {
  const registry = createAttachmentUploadRegistry();
  const generation = registry.generation();
  registry.begin("a");
  assert.equal(registry.isLive("a", generation), true, "compression has started");

  registry.cancel("a"); // no XHR yet — compression is pure main-thread work
  assert.equal(registry.isLive("a", generation), false);
});

test("a finished upload waiting its turn to commit is still cancellable", () => {
  const registry = createAttachmentUploadRegistry();
  const generation = registry.generation();
  const aborts = [];
  registry.begin("a");
  registry.trackRequest("a", { abort: () => aborts.push("a") });

  // Upload done, waiting for an earlier file in the batch to commit first.
  registry.cancel("a");

  assert.equal(registry.isLive("a", generation), false, "a removed card must not land in the draft");
  assert.deepEqual(aborts, ["a"]);
});

test("leaving and returning to a channel cannot revive the first visit's uploads", () => {
  const registry = createAttachmentUploadRegistry();
  const generationInA = registry.generation();
  registry.begin("a");

  registry.cancelAll(); // A → B
  registry.cancelAll(); // B → A

  assert.equal(
    registry.isLive("a", generationInA),
    false,
    "comparing channel ids alone would let the old upload pass again on the way back"
  );

  const generationInSecondA = registry.generation();
  registry.begin("b");
  assert.equal(registry.isLive("b", generationInSecondA), true, "work started after the return is live");
});

test("a request handed to a dead task is refused, not merely aborted", () => {
  const registry = createAttachmentUploadRegistry();
  const aborts = [];
  registry.begin("a");
  registry.cancel("a");

  const live = registry.trackRequest("a", { abort: () => aborts.push("late") });

  assert.equal(
    live,
    false,
    "an unsent request ignores abort(), so the caller has to be told not to send it"
  );
  assert.deepEqual(aborts, ["late"]);
});

test("a live task accepts its request", () => {
  const registry = createAttachmentUploadRegistry();
  registry.begin("a");
  assert.equal(registry.trackRequest("a", { abort: () => {} }), true);
});

test("leaving a channel aborts everything in flight", () => {
  const registry = createAttachmentUploadRegistry();
  const aborts = [];
  registry.begin("a");
  registry.begin("b");
  registry.trackRequest("a", { abort: () => aborts.push("a") });
  registry.trackRequest("b", { abort: () => aborts.push("b") });

  registry.cancelAll();
  assert.deepEqual(aborts.sort(), ["a", "b"]);
});

test("a settled task is no longer live", () => {
  const registry = createAttachmentUploadRegistry();
  const generation = registry.generation();
  registry.begin("a");
  registry.settle("a");
  assert.equal(registry.isLive("a", generation), false, "a committed row must not be committed twice");
});

test("bounded concurrency overlaps uploads but never exceeds the limit", async () => {
  const run = boundedConcurrency(2);
  const releases = [];
  let active = 0;
  let peak = 0;

  const tasks = [0, 1, 2, 3, 4].map(() =>
    run(
      () =>
        new Promise((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          releases.push(() => {
            active -= 1;
            resolve("done");
          });
        })
    )
  );

  await Promise.resolve();
  assert.equal(peak, 2, "only the limit may run at once");

  while (releases.length > 0) {
    releases.shift()();
    await Promise.resolve();
    await Promise.resolve();
  }

  assert.deepEqual(await Promise.all(tasks), ["done", "done", "done", "done", "done"]);
  assert.equal(peak, 2, "the queue must not burst past the limit as slots free up");
});

test("a failed task frees its slot instead of wedging the queue", async () => {
  const run = boundedConcurrency(1);
  const first = run(() => Promise.reject(new Error("upload failed")));
  await assert.rejects(first, /upload failed/);
  assert.equal(await run(() => Promise.resolve("second")), "second");
});

test("a task that throws synchronously also frees its slot", async () => {
  const run = boundedConcurrency(1);
  await assert.rejects(
    run(() => {
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(await run(() => Promise.resolve("after")), "after");
});
