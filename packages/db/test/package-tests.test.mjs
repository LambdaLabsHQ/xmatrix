import assert from "node:assert/strict";
import test from "node:test";
import { declaresUngatedTest, packageTestFiles } from "../scripts/package-tests.mjs";

test("only a direct node:test call keeps a file in the ungated package run", () => {
  assert.equal(declaresUngatedTest("integration('gated', () => {})\n"), false);
  assert.equal(declaresUngatedTest("test('runs', () => {})\n"), true);
  assert.equal(declaresUngatedTest("test.skip('kept', () => {})\n"), true);
  assert.equal(declaresUngatedTest("latest('name')\nintegration('gated', () => {})\n"), false);
});

test("the package check loads PostgreSQL-gated files only when a database is configured", () => {
  const ungated = packageTestFiles({});
  const configured = packageTestFiles({ XMATRIX_TEST_POSTGRES_URL: "postgres://example/db" });
  const required = packageTestFiles({ XMATRIX_REQUIRE_POSTGRES_TEST: "true" });
  assert.ok(ungated.length < configured.length);
  assert.equal(required.length, configured.length);
  assert.ok(ungated.some((file) => file.endsWith("migrations.test.mjs")));
  assert.ok(ungated.some((file) => file.endsWith("substrate.test.mjs")));
  assert.ok(ungated.some((file) => file.endsWith("online-index-migration.test.mjs")));
  assert.equal(ungated.some((file) => file.endsWith("account-deletion-postgres.test.mjs")), false);
  assert.ok(configured.some((file) => file.endsWith("account-deletion-postgres.test.mjs")));
  assert.equal(configured.filter((file) => ungated.includes(file)).length, ungated.length);
});
