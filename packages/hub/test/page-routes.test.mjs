import assert from "node:assert/strict";

import test from "node:test";
import { agentRunAllowed as allowed } from "./support/agent-run-routes.mjs";

test("an Agent Run reads, edits, links and arranges pages as its owner may", () => {
  assert.equal(allowed("GET", "/api/spaces/space-1/pages"), true);
  assert.equal(allowed("GET", "/api/spaces/space-1/pages/page-1"), true);
  assert.equal(allowed("GET", "/api/spaces/space-1/pages/page-1/history"), true);
  assert.equal(allowed("GET", "/api/spaces/space-1/pages/page-1/awareness"), true);
  assert.equal(allowed("GET", "/api/spaces/space-1/pages/page-1/changes"), true);
  assert.equal(allowed("PUT", "/api/spaces/space-1/pages/page-1"), true);
  assert.equal(allowed("GET", "/api/spaces/space-1/page-links"), true);
  assert.equal(allowed("POST", "/api/spaces/space-1/page-links"), true);
  assert.equal(allowed("PUT", "/api/spaces/space-1/page-links/link-1/resolution"), true);
  assert.equal(allowed("GET", "/api/channels/channel-1/page-space"), true);
  assert.equal(allowed("POST", "/api/channels/channel-1/page-writeback"), true);
  assert.equal(allowed("GET", "/api/channels/channel-1/pages"), true);
  assert.equal(allowed("GET", "/api/spaces/space-1/pages/page-1/mounts/mount-1/content"), false, "repository mounts are gone");
  for (const [method, path] of [
    ["POST", "/api/spaces/space-1/pages"],
    ["PATCH", "/api/spaces/space-1/pages/page-1"],
    ["DELETE", "/api/spaces/space-1/pages/page-1"],
    ["POST", "/api/spaces/space-1/pages/page-1/revisions/3/promote"],
    ["POST", "/api/spaces/space-1/pages/page-1/purge"],
  ]) {
    assert.equal(allowed(method, path), true, `${method} ${path}`);
  }
  assert.equal(allowed("DELETE", "/api/spaces/space-1/page-links/link-1"), false, "no such route");
  for (const method of ["GET", "PUT"]) {
    assert.equal(allowed(method, "/api/spaces/space-1/pages/page-1/read"), false, "how far a person has read is theirs");
  }
});
