import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTestPostgresTools } from "./test-postgres-tools.mjs";

test("test database tools resolve distro bindir when server tools are not on PATH", () => {
  const tools = resolveTestPostgresTools({ env: {}, probe(command) {
    if (command === "pg_config") return { status: 0, stdout: "/usr/lib/postgresql/17/bin\n" };
    return command.startsWith("/usr/lib/postgresql/17/bin/")
      ? { status: 0, stdout: "tool (PostgreSQL) 17.11\n" } : { status: null };
  } });
  assert.equal(tools.initdb, "/usr/lib/postgresql/17/bin/initdb");
});

test("explicit invalid test toolchain fails closed without PATH fallback", () => {
  const commands = [];
  assert.throws(() => resolveTestPostgresTools({ env: { XMATRIX_TEST_POSTGRES_BIN: "/missing" },
    probe(command) { commands.push(command); return { status: null }; } }), /PostgreSQL 17 test tools/);
  assert.deepEqual(commands, ["/missing/initdb"]);
});

test("mixed PostgreSQL major versions are rejected", () => {
  assert.throws(() => resolveTestPostgresTools({ env: {}, probe(command) {
    return command === "pg_config" ? { status: 1 } : { status: 0,
      stdout: `tool (PostgreSQL) ${command === "psql" ? "16.9" : "17.11"}` };
  } }), /No tests were skipped/);
});
