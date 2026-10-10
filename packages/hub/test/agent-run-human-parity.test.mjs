import assert from "node:assert/strict";

import test from "node:test";

import {
  agentRunCreatedByMetadata,
  agentRunDelegationDenied,
  messageMutationActor,
} from "../src/agent-run-channel-delegation.ts";
import { AGENT_RUN as run, agentRunAllowed as allowed } from "./support/agent-run-routes.mjs";

test("an Agent Run reaches the Human collaboration routes by default", () => {
  assert.equal(allowed("POST", "/api/channels"), true, "open a thread or create a Channel");
  assert.equal(allowed("PATCH", "/api/channels/channel-2"), true, "rename and visibility");
  assert.equal(allowed("PATCH", "/api/channels/channel-2/messages/message-1"), true, "edit its message");
  assert.equal(allowed("DELETE", "/api/channels/channel-2/messages/message-1"), true, "delete its message");
  assert.equal(allowed("POST", "/api/channels/channel-2/messages/message-1/reactions"), true, "react to a message");
  assert.equal(allowed("POST", "/api/channels/channel-2/pull-requests"), true, "report a pull request it opened");
  assert.equal(allowed("GET", "/api/spaces/space-2/launch-targets"), true, "read the launch catalog");
  assert.equal(allowed("GET", "/api/spaces/space-1/agent-registrations"), true, "read its Space's Agents");
  assert.equal(allowed("POST", "/api/spaces/space-1/agent-registrations/commands"), true, "add an Agent for its owner");
  assert.equal(allowed("POST", "/api/workspaces"), true, "register a directory on its Machine");
  assert.equal(allowed("POST", "/api/channels/channel-2/delete-requests"), false, "archive is retired");
  assert.equal(allowed("POST", "/api/cross-space-read/requests"), true, "ask its owner to read another Space");
  assert.equal(allowed("GET", "/api/spaces/space-2/cross-space-read-grants/csr_1"), true, "poll that answer");
  assert.equal(allowed("GET", "/api/machine-daemons"), true, "read its owner's Machines");
  assert.equal(allowed("GET", "/api/machine-daemons/harness-actions/harness:1"), true, "follow a harness action");
});

test("an Agent Run arranges pages as its owner may", () => {
  assert.equal(allowed("POST", "/api/spaces/space-1/pages"), true, "create a page");
  assert.equal(allowed("PATCH", "/api/spaces/space-1/pages/page-1"), true, "move or rename it");
  assert.equal(allowed("DELETE", "/api/spaces/space-1/pages/page-1"), true, "delete it");
  assert.equal(allowed("POST", "/api/spaces/space-1/pages/page-1/revisions/3/promote"), true, "restore a revision");
  assert.equal(allowed("PUT", "/api/spaces/space-1/pages/page-1/publication"), true, "publish it");
  assert.equal(allowed("PUT", "/api/spaces/space-1/pages/page-1/competition"), true, "open a block for competition");
  assert.equal(allowed("POST", "/api/spaces/space-1/page-migration/apply"), true, "apply the move to pages");
});

test("approval, membership and destructive Channel routes stay Human-only", () => {
  assert.equal(allowed("DELETE", "/api/channels/channel-2"), false);
  assert.equal(allowed("POST", "/api/channels/channel-2/unarchive"), false);
  assert.equal(allowed("POST", "/api/dangerous-action-requests/request-1"), false);
  assert.equal(allowed("POST", "/api/trace/access-requests/grant-1/decision"), false);
  assert.equal(allowed("POST", "/api/spaces/space-2/cross-space-read-grants/csr_1/decision"), false,
    "only the owner approves a Run's read outside its Space");
  assert.equal(allowed("POST", "/api/spaces/space-1/join-requests/request-1/decide"), false);
  assert.equal(allowed("POST", "/api/spaces/space-1/members"), false);
  assert.equal(allowed("DELETE", "/api/spaces/space-1"), false, "only a Human deletes a Space");
  assert.equal(allowed("POST", "/api/spaces/space-1/restore"), false);
  assert.equal(allowed("GET", "/api/space-deletions"), false);
  assert.equal(allowed("PATCH", "/api/channels/channel-2/messages/message-1/extra"), false);
});

test("ordinary Run secret creation is write-only and rejects About and read-only Runs", () => {
  assert.equal(allowed("POST", "/api/secrets"), true);
  for (const method of ["GET", "PATCH", "DELETE"]) assert.equal(allowed(method, "/api/secrets"), false);
  assert.equal(allowed("GET", "/api/secrets/key"), false);
  assert.equal(allowed("DELETE", "/api/secrets/key"), false);
  assert.equal(allowed("POST", "/api/secrets", { ...run, channelWriteAllowed: false }), false);
  assert.equal(allowed("POST", "/api/run-secrets"), true, "read the secrets its registration admits");
  assert.equal(allowed("POST", "/api/run-secrets", { ...run, channelWriteAllowed: false }), false);
  assert.equal(allowed("POST", "/api/secret-requests"), true, "ask its owner to type in a secret");
  for (const path of ["/api/secret-requests/fulfill", "/api/secret-requests/status"]) {
    assert.equal(allowed("POST", path), false, "only the owner answers a secret request");
  }
  assert.equal(allowed("POST", "/api/secrets", { ...run, runKind: "channel-about-session" }), false);
  // An About session, the only Run that carries a Space id, is refused for being read-only.
  assert.equal(allowed("POST", "/api/secrets", { ...run, runKind: "channel-about-session",
    managementSpaceId: "space-1", channelWriteAllowed: false }), false);
});

test("a Channel About session gains none of the collaboration routes", () => {
  const about = { ...run, runKind: "channel-about-session", channelWriteAllowed: false };
  assert.equal(allowed("POST", "/api/channels", about), false);
  assert.equal(allowed("PATCH", "/api/channels/channel-2", about), false);
  assert.equal(allowed("DELETE", "/api/channels/channel-1/messages/message-1", about), false);
  assert.equal(allowed("POST", "/api/cross-space-read/requests", about), false);
});

test("delegation refuses a read-only Run before touching any authority", async () => {
  const denied = await agentRunDelegationDenied({},
    { ...run, channelWriteAllowed: false }, ["channel-2"]);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "agent_run_forbidden");
});

test("a Human edits as a user and never goes through Run delegation", async () => {
  const actor = await messageMutationActor({}, { id: "user-1", email: "u@example.test", name: "U" }, "channel-2");
  assert.deepEqual(actor.principal, { kind: "user", id: "user-1" });
  assert.equal(actor.from.identityId, "user:user-1");
  assert.equal(actor.run, undefined);
});

test("created-by attribution names the exact Run and replaces caller claims", () => {
  const metadata = { createdBy: "web", createdByAgentId: "someone-else", ...agentRunCreatedByMetadata(run) };
  assert.deepEqual(metadata, {
    createdBy: "agent", createdByAgentId: "agent-1", createdByAgentName: "claude", createdByRunId: "run-1",
  });
});
