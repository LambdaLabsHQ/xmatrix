import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescriptModule } from "./load-typescript-module.mjs";

const { parseAgentRoutingRequirements } = await loadTypescriptModule(
  new URL("../src/agent-routing.ts", import.meta.url),
);

test("an omitted model survives a second parse so Hub plan/dispatch stay idempotent", () => {
  const once = parseAgentRoutingRequirements({ unattended: false, harness: "codex", requiredCapabilities: [] });
  assert.equal(once.model, "");
  const twice = parseAgentRoutingRequirements(once);
  assert.equal(twice.model, "");
  assert.equal(twice.harness, "codex");
});
