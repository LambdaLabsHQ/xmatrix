import assert from "node:assert/strict";

import test from "node:test";

import {
  agentRunCreatedByMetadata,
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
  assert.equal(allowed("POST", "/api/harness-sign-in-requests"), true, "ask its owner to sign a harness in");
  assert.equal(allowed("POST", "/api/machine-daemons/harness-actions"), true, "ask its own Machine to look again");
});

test("an Agent Run arranges pages as its owner may", () => {
  assert.equal(allowed("POST", "/api/spaces/space-1/pages"), true, "create a page");
  assert.equal(allowed("PATCH", "/api/spaces/space-1/pages/page-1"), true, "move or rename it");
  assert.equal(allowed("DELETE", "/api/spaces/space-1/pages/page-1"), true, "delete it");
  assert.equal(allowed("POST", "/api/spaces/space-1/pages/page-1/revisions/3/promote"), true, "restore a revision");
  assert.equal(allowed("PUT", "/api/spaces/space-1/pages/page-1/publication"), true, "publish it");
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

test("ordinary Run secret creation is write-only", () => {
  assert.equal(allowed("POST", "/api/secrets"), true);
  for (const method of ["GET", "PATCH", "DELETE"]) assert.equal(allowed(method, "/api/secrets"), false);
  assert.equal(allowed("GET", "/api/secrets/key"), false);
  assert.equal(allowed("DELETE", "/api/secrets/key"), false);
  assert.equal(allowed("POST", "/api/run-secrets"), true, "read the secrets its registration admits");
  assert.equal(allowed("POST", "/api/secret-requests"), true, "ask its owner to type in a secret");
  for (const path of ["/api/secret-requests/fulfill", "/api/secret-requests/status"]) {
    assert.equal(allowed("POST", path), false, "only the owner answers a secret request");
  }
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

test("an Agent Run with attachment write sends a large file in parts, as a person does", () => {
  const writer = { ...run, permissions: ["channel.attachments.write"] };
  const base = "/api/relay-v2/private-r2/uploads/intent-1";
  for (const scope of ["", "/scope/channel:channel-1"]) {
    assert.equal(allowed("POST", `${base}/multipart${scope}`, writer), true);
    assert.equal(allowed("PUT", `${base}/multipart/parts/1${scope}`, writer), true);
    assert.equal(allowed("PUT", `${base}/multipart/parts/10000${scope}`, writer), true);
    assert.equal(allowed("POST", `${base}/multipart/complete${scope}`, writer), true);
    assert.equal(allowed("POST", `${base}/multipart${scope}`), false);
    assert.equal(allowed("PUT", `${base}/multipart/parts/1${scope}`), false);
  }
  assert.equal(allowed("PUT", `${base}/multipart/parts/0`, writer), false);
  assert.equal(allowed("PUT", `${base}/multipart`, writer), false);
});
