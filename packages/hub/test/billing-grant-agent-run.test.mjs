import assert from "node:assert/strict";
import { test } from "node:test";

import { agentRunAllowed as allowed } from "./support/agent-run-routes.mjs";

test("an Agent Run reaches only the complimentary-Pro routes of the operator surface", () => {
  assert.equal(allowed("GET", "/api/admin/billing-grants/candidate"), true);
  assert.equal(allowed("POST", "/api/admin/billing-grants"), true);
  // The routes themselves admit only a live Run whose owner is a platform admin.
  assert.equal(allowed("GET", "/api/admin/billing-grants"), false);
  assert.equal(allowed("POST", "/api/admin/billing-grants/candidate"), false);
  assert.equal(allowed("GET", "/api/admin/audit"), false);
  assert.equal(allowed("POST", "/api/admin/agent-launch/handover"), false);
});
