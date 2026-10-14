import assert from "node:assert/strict";
import test from "node:test";
import { connectedAppsSpawnFields } from "../dist/connected-apps-spawn.js";
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

test("a Run's spawn names the Space's connected apps an Agent can act in", async () => {
  const database = tx([{ provider_id: "gmail" }, { provider_id: "sentry" }, { provider_id: "webhook" }]);
  // In catalog order; a Webhook only receives events, so there is nothing to act in.
  assert.deepEqual(await connectedAppsSpawnFields(database, "space-1"), { connectedApps: ["Gmail", "Sentry"] });
  assert.deepEqual(database.calls[0].values, ["space-1"]);
  assert.match(database.calls[0].text, /status='configured'/);
});

test("a Space without connected apps adds nothing to the spawn", async () => {
  assert.deepEqual(await connectedAppsSpawnFields(tx([]), "space-1"), {});
});
