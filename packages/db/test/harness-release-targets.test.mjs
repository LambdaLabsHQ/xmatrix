import assert from "node:assert/strict";
import test from "node:test";
import { readHarnessReleaseTargets } from "../dist/index.js";

/** A database that records each query, held to the client's 10,000-row result bound. */
function recordingDatabase() {
  const queries = [];
  return {
    queries,
    transaction: async (_context, callback) => callback({
      query: async (query) => {
        assert.ok(query.maxRows <= 10_000, `maxRows ${query.maxRows} exceeds the client's result bound`);
        queries.push(query);
        return [];
      },
    }),
  };
}

test("every watched preset is read in one statement within the client's result bound", async () => {
  const database = recordingDatabase();
  const releases = Array.from({ length: 40 }, (_, index) => ({ presetId: `preset-${index}`, version: "1.0.0" }));
  assert.deepEqual(await readHarnessReleaseTargets(database, { requestId: "release", releases }), []);
  assert.equal(database.queries.length, 1);
  const [{ values, maxRows }] = database.queries;
  assert.deepEqual(values[1], releases.map(({ presetId }) => presetId));
  assert.equal(maxRows, values[4] * releases.length);
});

test("a pass with no published version reads nothing", async () => {
  const database = recordingDatabase();
  assert.deepEqual(await readHarnessReleaseTargets(database, { requestId: "release", releases: [] }), []);
  assert.equal(database.queries.length, 0);
});
