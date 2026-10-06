const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  dragCarriesFiles,
  nextDropDepth,
  pickDropSink,
  transferAttachmentCandidates,
} = require("./composer-attachment-drop.ts");

test("only an OS file drag claims the drop surface", () => {
  assert.equal(dragCarriesFiles(["Files"]), true);
  assert.equal(dragCarriesFiles(["text/plain", "Files"]), true);
  assert.equal(
    dragCarriesFiles(["text/plain"]),
    false,
    "in-app drags (channel reparenting, text) must fall through untouched"
  );
  assert.equal(dragCarriesFiles([]), false);
  assert.equal(dragCarriesFiles(null), false);
  assert.equal(dragCarriesFiles(undefined), false);
});

test("crossing into a child element does not read as leaving the window", () => {
  let depth = 0;
  depth = nextDropDepth(depth, "enter"); // window
  depth = nextDropDepth(depth, "enter"); // message list
  depth = nextDropDepth(depth, "leave"); // message list
  assert.ok(depth > 0, "the overlay must survive a pointer moving across nested elements");
  depth = nextDropDepth(depth, "leave");
  assert.equal(depth, 0);
});

test("depth cannot go negative and reset always clears it", () => {
  assert.equal(nextDropDepth(0, "leave"), 0, "a stray dragleave must not push the counter below zero");
  assert.equal(nextDropDepth(7, "reset"), 0);
});

test("an open thread draft outranks the channel composer beneath it", () => {
  const sink = pickDropSink([
    { id: "channel", priority: 0, seq: 1 },
    { id: "thread", priority: 1, seq: 2 },
  ]);
  assert.equal(sink.id, "thread");
});

test("the newest registration wins a priority tie", () => {
  const sink = pickDropSink([
    { id: "old", priority: 1, seq: 4 },
    { id: "new", priority: 1, seq: 9 },
  ]);
  assert.equal(sink.id, "new");
});

test("no registered sink means no drop target", () => {
  assert.equal(pickDropSink([]), null);
});

test("dropped folders are recognised through the item list", () => {
  const candidates = transferAttachmentCandidates({
    items: [
      { kind: "file", getAsFile: () => ({ name: "a.pdf" }), webkitGetAsEntry: () => ({ isDirectory: false }) },
      { kind: "file", getAsFile: () => ({ name: "src" }), webkitGetAsEntry: () => ({ isDirectory: true }) },
    ],
    files: [{ name: "a.pdf" }, { name: "src" }],
  });

  assert.deepEqual(
    candidates.map((candidate) => [candidate.file.name, candidate.isDirectory]),
    [["a.pdf", false], ["src", true]],
    "items is the only list that can tell a folder from a file"
  );
});

test("non-file drag items are ignored", () => {
  const candidates = transferAttachmentCandidates({
    items: [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => ({ name: "a.pdf" }) },
    ],
    files: [],
  });
  assert.deepEqual(candidates.map((candidate) => candidate.file.name), ["a.pdf"]);
});

test("a transfer with no usable items falls back to the file list", () => {
  const candidates = transferAttachmentCandidates({
    items: [{ kind: "string", getAsFile: () => null }],
    files: [{ name: "a.pdf" }, { name: "b.png" }],
  });
  assert.deepEqual(candidates.map((candidate) => candidate.file.name), ["a.pdf", "b.png"]);
});

test("an empty transfer yields nothing rather than throwing", () => {
  assert.deepEqual(transferAttachmentCandidates({}), []);
  assert.deepEqual(transferAttachmentCandidates({ items: null, files: null }), []);
});
