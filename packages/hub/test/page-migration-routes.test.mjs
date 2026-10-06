import assert from "node:assert/strict";

import test from "node:test";
import { agentRunAllowed as allowed } from "./support/agent-run-routes.mjs";

test("an Agent Run reads, drafts and applies the move to pages; only a human revises it", async () => {
  assert.equal(allowed("GET", "/api/spaces/space-1/page-migration"), true);
  assert.equal(allowed("PUT", "/api/spaces/space-1/page-migration/draft"), true);
  assert.equal(allowed("PATCH", "/api/spaces/space-1/page-migration/draft"), false);
  assert.equal(allowed("POST", "/api/spaces/space-1/page-migration/apply"), true);
  // Starting from a repository is a person's choice, like revising the draft.
  assert.equal(allowed("GET", "/api/spaces/space-1/page-migration/import/repositories"), false);
  assert.equal(allowed("POST", "/api/spaces/space-1/page-migration/import"), false);

});
