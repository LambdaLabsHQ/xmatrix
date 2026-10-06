import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

function scheduledExecutionFlag(source) {
  const matches = [
    ...source.matchAll(/^RELAY_AUTOMATION_EXECUTION_ENABLED\s*=\s*"(true|false)"\s*$/gmu),
  ];
  assert.equal(matches.length, 1, "scheduled execution flag must be declared exactly once");
  return matches[0][1];
}

function scheduledRunTimeout(source) {
  const matches = [
    ...source.matchAll(/^RELAY_AUTOMATION_RUN_TIMEOUT_MS\s*=\s*"([0-9]+)"\s*$/gmu),
  ];
  assert.equal(matches.length, 1, "scheduled run timeout must be declared exactly once");
  return Number(matches[0][1]);
}

test("production enables Automation execution while test environments fail closed", async () => {
  const [production, testConfig, testDeployConfig] = await Promise.all([
    readFile(new URL("../wrangler.toml", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.test.toml", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.test-deploy.toml", import.meta.url), "utf8"),
  ]);

  assert.equal(scheduledExecutionFlag(production), "true");
  assert.equal(scheduledExecutionFlag(testConfig), "false");
  assert.equal(scheduledExecutionFlag(testDeployConfig), "false");
  assert.equal(scheduledRunTimeout(production), 30 * 60_000);
  assert.equal(scheduledRunTimeout(testConfig), 30 * 60_000);
  assert.equal(scheduledRunTimeout(testDeployConfig), 30 * 60_000);
});
