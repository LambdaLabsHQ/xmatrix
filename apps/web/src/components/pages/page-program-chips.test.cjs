const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { programBlockName, programStatusText } = require("./page-program-chips.ts");

test("a norn run block names its program, and any other block names none", () => {
  assert.deepEqual(["norn run", "norn run review", "norn", "norn run two words", "ts"].map(programBlockName),
    ["main", "review", null, null, null]);
});

test("a program's line says whom it waits on, how it ended, or why it does not run", () => {
  const request = (holder, reply) => ({ holder, text: "Review", by: null, reply });
  assert.equal(programStatusText(undefined), "starting…");
  assert.equal(programStatusText({ name: "main", state: "running", requests: [request("@codex", null), request("@claude", "ok"), request("@codex", null)] }),
    "waiting on @codex");
  assert.equal(programStatusText({ name: "main", state: "completed", result: "sound", requests: [] }), "finished: sound");
  assert.equal(programStatusText({ name: "main", state: "failed", result: "Removed from its page", requests: [] }), "stopped: Removed from its page");
  assert.equal(programStatusText({ name: "main", state: "not_started", problem: "1:1 a request is dropped\nmore", requests: [] }), "1:1 a request is dropped");
});
