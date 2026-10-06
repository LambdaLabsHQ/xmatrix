import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentRunUploadScopeId,
} from "../src/agent-run-upload-scope.ts";

/* An Agent Run may only register uploads inside its birth Channel, but that
   Channel has to be named the way the domain names it: message_attachments_put
   binds a ref only when the ref sits in the message's own scope, and an open
   Channel's messages live in the Space scope. Pinning every Agent Run upload to
   `channel:<id>` therefore made `xmatrix send --file` impossible for agents in
   any open Channel — it failed at bind time with "verified canonical attachment
   ref is unavailable". */
test("open channels resolve to the Space scope their messages use", () => {
  assert.equal(
    agentRunUploadScopeId("channel-1", { mode: "open", spaceId: "space-1" }),
    "space:space-1",
  );
});

test("closed channels stay isolated to the channel scope", () => {
  assert.equal(
    agentRunUploadScopeId("channel-1", { mode: "closed", spaceId: "space-1" }),
    "channel:channel-1",
  );
});

test("an unreadable channel keeps the channel-scoped confinement", () => {
  assert.equal(agentRunUploadScopeId("channel-1", undefined), "channel:channel-1");
  assert.equal(agentRunUploadScopeId("channel-1", { mode: "open" }), "channel:channel-1");
});
