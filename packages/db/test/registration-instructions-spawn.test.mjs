import assert from "node:assert/strict";
import test from "node:test";
import { parseSpaceAgentConfiguration } from "@xmatrix/protocol";
import { registrationInstructionsSpawnFields } from "../dist/registration-instructions-spawn.js";

test("a registration runs its Space instructions as the trusted initial prompt", () => {
  assert.deepEqual(registrationInstructionsSpawnFields({ instructions: "Be brief.", workspaceReferences: [], secretReferences: [] }),
    { roleInitialPrompt: "Be brief." });
  assert.deepEqual(registrationInstructionsSpawnFields({ workspaceReferences: [], secretReferences: [] }), {});
});

test("a configuration stored with a retired Role assignment launches with its instructions alone", () => {
  const role = { roleId: "role-reviewer", roleVersion: "1.0.0", roleDigest: `sha256:${"c".repeat(64)}` };
  const configuration = parseSpaceAgentConfiguration({ role, instructions: "Be brief.", workspaceReferences: [], secretReferences: [] });
  const fields = registrationInstructionsSpawnFields(configuration);
  assert.deepEqual(fields, { roleInitialPrompt: "Be brief." });
  for (const retired of ["roleReminder", "roleSkills", "roleAppRequirements", "agentAvatarUrl"]) {
    assert.equal(Object.hasOwn(fields, retired), false);
  }
});
