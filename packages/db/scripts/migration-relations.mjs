import { readFile, readdir } from "node:fs/promises";

// Replays the relation-level DDL of the checked-in migrations in order, so a
// table renamed by a later migration is reported under its current name. This
// is the one inventory of the schema: the production substrate check compares
// a live database with it, and the shard and purge classifications are tested
// against it, so a migration edits no list of tables.
export async function checkedInMigrationRelations() {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const tables = new Set();
  const views = new Set();
  for (const name of names) {
    const sql = (await readFile(new URL(name, directory), "utf8")).replace(/--[^\n]*/gu, "");
    const statement = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+((?:control|data)\.[a-z0-9_]+)|ALTER\s+TABLE\s+((?:control|data)\.[a-z0-9_]+)\s+RENAME\s+TO\s+([a-z0-9_]+)\s*;|CREATE\s+VIEW\s+((?:control|data)\.[a-z0-9_]+)|DROP\s+VIEW(?:\s+IF\s+EXISTS)?\s+((?:control|data)\.[a-z0-9_]+)|DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+((?:control|data)\.[a-z0-9_]+)/giu;
    for (const [, created, renamed, renamedTo, view, droppedView, droppedTable] of sql.matchAll(statement)) {
      if (created) tables.add(created);
      if (droppedTable) tables.delete(droppedTable);
      if (renamed) {
        if (!tables.delete(renamed)) throw new Error(`${name} renames unknown table ${renamed}`);
        tables.add(`${renamed.split(".")[0]}.${renamedTo}`);
      }
      if (view) views.add(view);
      if (droppedView) views.delete(droppedView);
    }
  }
  return { tables, views };
}
