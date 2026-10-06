import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_CAPABILITY_POLICIES,
  channelCapabilityCte,
  channelCapabilityPredicate,
  requireChannelCapability,
  requireAuthorizedChannel,
} from "../dist/channel-capability-policy.js";

class DomainError extends Error {
  constructor(failure) {
    super(failure.message);
    Object.assign(this, failure);
  }
}

const error = (failure) => new DomainError(failure);
const row = (overrides = {}) => ({ channel_id: "channel-1", space_id: "space-1",
  mode: "open", metadata_json: {}, version: 7, ...overrides });
const scope = (capability, principal = { kind: "user", id: "user-1" }) => ({
  capability, channelId: "channel-1", spaceId: "space-1", principal, error,
});

function transaction(rows) {
  const calls = [];
  return { calls, transaction: { async query(query) { calls.push(query); return rows; } } };
}

test("the registry fixes principals, roles and lifecycle locks for every named capability", () => {
  assert.deepEqual(CHANNEL_CAPABILITY_POLICIES.message_content_read,
    { principals: ["user", "agent"], humanRoles: "all", lock: "none" });
  assert.equal(CHANNEL_CAPABILITY_POLICIES.message_active_command.lock, "share");
  assert.equal(CHANNEL_CAPABILITY_POLICIES.message_append.lock, "no_key_update");
  assert.equal(CHANNEL_CAPABILITY_POLICIES.runtime_new_work.lock, "update");
});

// Archive is retired: a conversation that was once archived reads and writes like any other.
test("single-channel gates mask missing access and never distinguish an archive", async () => {
  const missing = transaction([]);
  await assert.rejects(requireChannelCapability(missing.transaction,
    scope("message_content_read")), (value) => value instanceof DomainError &&
      value.code === "channel_not_found" && value.status === 404);

  const found = transaction([row()]);
  const grant = await requireChannelCapability(found.transaction, scope("message_active_command"));
  assert.deepEqual(grant, { channelId: "channel-1", spaceId: "space-1", mode: "open",
    metadata: {}, version: 7 });
  assert.doesNotMatch(found.calls[0].text, /archived_at/u);
});

test("shared predicates preserve Human, Agent, closed, role, and grant rules", () => {
  const predicate = channelCapabilityPredicate({ capability: "message_content_read",
    channelAlias: "candidate", principalKindSql: "input.kind", principalIdSql: "input.id" });
  assert.match(predicate, /data\.space_members/u);
  assert.match(predicate, /data\.run_agent_registrations/u);
  assert.doesNotMatch(predicate, /agent_profiles/u);
  assert.match(predicate, /data\.channel_access/u);
  assert.doesNotMatch(predicate, /'direct'/u, "there are no direct conversations to exclude");
  assert.match(predicate, /role IN \('owner','admin'\)/u);
  const write = channelCapabilityPredicate({ capability: "message_active_command",
    channelAlias: "candidate", principalKindSql: "input.kind", principalIdSql: "input.id" });
  assert.match(write, /channel_member\.role NOT IN \('viewer','participant'\)/u);
  // A participant writes only in the intake conversation they started.
  assert.match(write, /channel_member\.role='participant'\s+AND candidate\.metadata_json->>'intakeOf'=input\.id/u);
  assert.doesNotMatch(write, /archived_at/u);
  assert.match(write, /candidate\.mode<>'closed'/u);
});

test("lock behavior comes only from the capability registry", async () => {
  for (const [capability, expected] of [
    ["message_content_read", null],
    ["message_active_command", /FOR SHARE OF c$/u],
    ["message_append", /FOR NO KEY UPDATE OF c$/u],
    ["runtime_new_work", /FOR UPDATE OF c$/u],
  ]) {
    const db = transaction([row()]);
    await requireChannelCapability(db.transaction, scope(capability));
    if (expected) assert.match(db.calls[0].text, expected);
    else assert.doesNotMatch(db.calls[0].text, /FOR (?:SHARE|UPDATE)/u);
  }
  const cte = channelCapabilityCte({ capability: "message_active_command", inputCte: "message_input" });
  assert.match(cte, /TRUE AS authorized/u);
  assert.match(cte, /FOR SHARE OF c/u);
  assert.throws(() => requireAuthorizedChannel(null, error), (value) => value.code === "channel_not_found");
  assert.doesNotThrow(() => requireAuthorizedChannel(true, error));
});
