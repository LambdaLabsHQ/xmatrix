import assert from "node:assert/strict";
import test from "node:test";

import { extractStaticNamedQueries } from "../scripts/sql-prepare-audit.mjs";

test("extracts static named SQL and reports dynamic statements", () => {
  const result = extractStaticNamedQueries(`
    query({ name: "static_v1", text: \`SELECT * FROM data.messages WHERE message_id=$1\` });
    query({ name: "joined_v1", text: "SELECT " + "1" });
    query({ name: "dynamic_v1", text: \`SELECT ${"${column}"} FROM data.messages\` });
  `, "fixture.ts");
  assert.deepEqual(result.queries.map(({ name, text, line }) => ({ name, text, line })), [
    { name: "static_v1", text: "SELECT * FROM data.messages WHERE message_id=$1", line: 2 },
    { name: "joined_v1", text: "SELECT 1", line: 3 },
  ]);
  assert.equal(result.dynamic, 1);
});
