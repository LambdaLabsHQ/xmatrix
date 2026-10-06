import assert from "node:assert/strict";
import { sourceText, sourceFiles } from "./source-file.fixture.mjs";
import { test } from "node:test";

const OWNER = "agent-registration-rows.ts";

test("only agent-registration-rows reads an access row and writes the registration key", () => {
  const offenders = sourceFiles().filter(name => name.endsWith(".ts") && name !== OWNER).filter(name => {
    const text = sourceText(name);
    return text.includes("grant_execution_revision ??") || text.includes("policy_execution_revision ??") ||
      text.includes("space_id=$1 AND owner_user_id=$2 AND machine_id=$3 AND harness=$4");
  });
  assert.deepEqual(offenders, [], "use registrationOwnerGrant/registrationAccess and REGISTRATION_KEY_SQL");
});
