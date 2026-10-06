import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Postgres gives a parameter one type, inferred from its first typed use. A
 * statement that casts `$3::text` for a JSON value and then assigns the same
 * `$3` to a timestamp column is refused (42804) on every execution. That
 * refusal sat in the same-machine handoff fence: every handoff waited until it
 * expired while the Channel was told the work had moved. A parameter cast to
 * text must be cast again where a timestamp column takes it.
 */
test("no statement assigns a text-cast parameter to a timestamp column", async () => {
  const directory = new URL("../src/", import.meta.url);
  const offenders = [];
  for (const file of (await readdir(directory, { recursive: true })).filter(name => name.endsWith(".ts"))) {
    const source = await readFile(new URL(file, directory), "utf8");
    for (const statement of source.matchAll(/`([^`]*\b(?:UPDATE|INSERT)\b[^`]*)`/gu)) {
      const sql = statement[1];
      for (const [, parameter] of sql.matchAll(/\$(\d+)::text/gu)) {
        if (new RegExp(`\\b\\w+_at\\s*=\\s*\\$${parameter}(?![\\d:])`, "u").test(sql)) {
          offenders.push(`${file}:${source.slice(0, statement.index).split("\n").length} $${parameter}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});
