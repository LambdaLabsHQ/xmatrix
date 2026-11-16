import assert from "node:assert/strict";
import test from "node:test";

import { readerPatterns, removedTables, runtimeReaders } from "../scripts/contract-readers.mjs";

test("a contract migration removes the tables it drops or renames away", () => {
  assert.deepEqual(removedTables(`-- DROP TABLE data.commented_out;
    DROP TABLE data.gone; DROP TABLE IF EXISTS control.maybe_gone;
    ALTER TABLE data.old_name RENAME TO new_name; DROP VIEW data.some_view;
    CREATE TABLE data.fresh (id text);`), ["data.gone", "control.maybe_gone", "data.old_name"]);
});

test("runtime source still naming a removed table refuses the contract", () => {
  const readers = runtimeReaders("HEAD", ["data.messages"]);
  assert.ok(readers.some((line) => line.startsWith("HEAD:packages/db/src/")));
  assert.ok(readers.every((line) => !/\/test\/|\.test\./u.test(line)));
  assert.deepEqual(runtimeReaders("HEAD", ["data.never_created_anywhere"]), []);
  assert.deepEqual(runtimeReaders("HEAD", []), []);
});

test("a table is in use when named with its schema or held as a bare name to interpolate", () => {
  // `data.${table}` with `table: "app_feishu_tickets"` names the table nowhere with its schema.
  assert.ok(runtimeReaders("HEAD", ["data.app_feishu_tickets"]).some((line) => line.includes('"app_feishu_tickets"')));
  const lines = (table) => readerPatterns(table).map((pattern) => new RegExp(pattern, "u"));
  const uses = (text, table = "data.gone") => lines(table).some((pattern) => pattern.test(text));
  assert.ok(uses("SELECT 1 FROM data.gone WHERE"));
  assert.ok(uses('DELETE FROM "data"."gone"'));
  assert.ok(uses('{ table: "gone" }'));
  // A route or a response field that shares the name reaches no table.
  assert.ok(!uses("app.get(`/api/gone/:id`)"));
  assert.ok(!uses("return c.json({ gone: [] })"));
  assert.ok(!uses("FROM data.gone_archive"));
  // A name given without a schema is matched as any bare word.
  assert.ok(uses("app.get(`/api/gone`)", "gone"));
});
