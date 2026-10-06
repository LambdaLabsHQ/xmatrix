import assert from "node:assert/strict";
import test from "node:test";

import { assertExpandOnlyMigration } from "./d1-expand-only-migration-policy.mjs";

test("expand-only D1 policy accepts table creation and additive columns", () => {
  assert.doesNotThrow(() => assertExpandOnlyMigration("CREATE TABLE item (id TEXT);"));
  assert.doesNotThrow(() => assertExpandOnlyMigration("ALTER TABLE item ADD COLUMN label TEXT;"));
  assert.doesNotThrow(() => assertExpandOnlyMigration("FOREIGN KEY (id) REFERENCES x(id) ON DELETE CASCADE;"));
  assert.doesNotThrow(() => assertExpandOnlyMigration(
    "CREATE TRIGGER item_update AFTER UPDATE ON item BEGIN INSERT INTO events VALUES (NEW.id); END;",
  ));
});

test("expand-only D1 policy rejects destructive or data-rewriting migrations", () => {
  for (const sql of [
    "DROP TABLE item;",
    "DELETE FROM item;",
    "UPDATE item SET label = '';",
    "ALTER TABLE item RENAME TO old_item;",
    "VACUUM;",
  ]) {
    assert.throws(() => assertExpandOnlyMigration(sql), /not expand-only/u);
  }
});
