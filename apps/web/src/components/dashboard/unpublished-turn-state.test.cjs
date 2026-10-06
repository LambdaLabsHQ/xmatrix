const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { unpublishedTurns } = require("./unpublished-turn-state.ts");

test("only a submitted completed turn with no publication receipt shows missing reply", () => {
  const completed = { id: "completed", state: "completed", inputDisposition: "submitted" };
  const rows = [completed,
    { ...completed, id: "published", finalReply: { messageId: "reply" } },
    { ...completed, id: "context", inputDisposition: "pending" },
    { ...completed, id: "existing", inputDisposition: "resumed_existing" },
    { ...completed, id: "legacy", inputDisposition: undefined },
    ...["accepted", "running", "failed", "interrupted", "unknown"].map(state => ({ ...completed, id: state, state })),
  ];
  assert.deepEqual(unpublishedTurns(rows).map(row => row.id), ["completed"]);
  assert.deepEqual(unpublishedTurns([]), []);
});
