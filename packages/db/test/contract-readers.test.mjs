import assert from "node:assert/strict";
import test from "node:test";

import { removedTables, runtimeReaders } from "../scripts/contract-readers.mjs";

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
