import assert from "node:assert/strict";
import test from "node:test";
import { spaceRulesSpawnFields } from "../dist/space-rules-spawn.js";

function tx(rows) {
  const calls = [];
  return { calls, query: async (query) => { calls.push(query); return rows; } };
}

test("a Run's spawn names the Space's rules page by id only", async () => {
  const database = tx([{ page_id: "page-rules" }]);
  assert.deepEqual(await spaceRulesSpawnFields(database, "space-1"), { spaceRulesPageId: "page-rules" });
  assert.deepEqual(database.calls[0].values, ["space-1"]);
  // The join drops a rules page deleted since it was chosen.
  assert.match(database.calls[0].text, /JOIN data\.pages p ON p\.space_id=s\.space_id AND p\.page_id=s\.metadata_json->>'governancePageId'/);
});

test("a Space without a rules page adds nothing to the spawn", async () => {
  assert.deepEqual(await spaceRulesSpawnFields(tx([]), "space-1"), {});
});
