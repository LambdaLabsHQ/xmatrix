import assert from "node:assert/strict";
import test from "node:test";
import {
  declaresPostgresTest,
  declaresUngatedTest,
  packageTestFiles,
  postgresSuitePlan,
} from "../scripts/package-tests.mjs";

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

test("the PostgreSQL suite plan discovers every gated database test without overlap", () => {
  assert.equal(declaresPostgresTest("integration('real pg', () => {})\n"), true);
  assert.equal(declaresPostgresTest("const u = process.env.XMATRIX_TEST_POSTGRES_URL;\n"), true);
  assert.equal(declaresPostgresTest("test('pure unit', () => {})\n"), false);
  const plan = postgresSuitePlan();
  assert.ok(plan.parallel.some((file) => file.endsWith("account-deletion-postgres.test.mjs")));
  assert.ok(plan.parallel.some((file) => file.endsWith("online-index-migration.test.mjs")));
  assert.ok(plan.serial.some((file) => file.endsWith("agent-launch-postgres.test.mjs")));
  const seen = new Set();
  for (const file of [...plan.parallel, ...plan.serial]) {
    assert.equal(seen.has(file), false, `duplicate PostgreSQL suite entry: ${file}`);
    seen.add(file);
  }
  const external = new Set(plan.external);
  const quarantined = new Set(plan.quarantined);
  for (const file of seen) {
    const base = file.split(/[\\/]/u).at(-1);
    assert.equal(external.has(base), false, `external test must not run in single-cluster plan: ${base}`);
    assert.equal(quarantined.has(base), false, `quarantined test must not run in single-cluster plan: ${base}`);
  }
});
