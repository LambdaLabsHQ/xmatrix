const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  boundedConcurrency,
  createAttachmentUploadRegistry,
  planAttachmentIntake,
} = require("./composer-attachment-intake.ts");

let idCounter = 0;

function plan(overrides = {}) {
  idCounter = 0;
  return planAttachmentIntake({
    candidates: [],
    attachmentsEnabled: true,
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

test("a batch of any size is taken whole", () => {
  const result = plan({
    candidates: Array.from({ length: 40 }, (_, index) => candidate(`f${index}.pdf`, 10)),
  });

  assert.equal(result.entries.length, 40);
  assert.equal(result.error, null);
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

test("a task sent with its message outlives leaving the channel until it is cancelled", () => {
  const registry = createAttachmentUploadRegistry();
  const generation = registry.generation();
  const aborts = [];
  registry.begin("sent");
  registry.begin("draft");
  registry.trackRequest("sent", { abort: () => aborts.push("sent") });
  registry.trackRequest("draft", { abort: () => aborts.push("draft") });
  assert.equal(registry.detach("sent"), true);

  registry.cancelAll();
  assert.deepEqual(aborts, ["draft"]);
  assert.equal(registry.isLive("sent", generation), true, "the message still waits for it");
  assert.equal(registry.isLive("draft", generation), false);

  registry.cancel("sent");
  assert.deepEqual(aborts, ["draft", "sent"]);
  assert.equal(registry.isLive("sent", generation), false);
});

test("only a live task can be handed to a message", () => {
  const registry = createAttachmentUploadRegistry();
  registry.begin("a");
  registry.cancel("a");
  assert.equal(registry.detach("a"), false);
  assert.equal(registry.detach("never-started"), false);
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
