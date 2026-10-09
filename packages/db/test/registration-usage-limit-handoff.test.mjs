import assert from "node:assert/strict";
import test from "node:test";
import { RegistrationAccessError } from "../dist/agent-registration-errors.js";
import { PostgresRegistrationRebornRepository, autoHandoffSuccessorOrder } from "../dist/registration-reborn.js";

test("successors never share the exhausted pool or read empty, and the highest quota pace goes first", () => {
  assert.deepEqual(autoHandoffSuccessorOrder([
    { harness: "kimi", sharesSourcePool: false, quotaPace: 0.2 },
    { harness: "grok", sharesSourcePool: false },
    { harness: "codex", sharesSourcePool: false, quotaPace: 2.5 },
    { harness: "claude-work", sharesSourcePool: true, quotaPace: 3 },
    { harness: "zai", sharesSourcePool: false, quotaPace: 0 },
    { harness: "aider", sharesSourcePool: false, quotaPace: 2.5 },
  ]), ["aider", "codex", "grok", "kimi"]);
});

/** The repository with its database steps replaced by recorded stand-ins. */
function repository({ located = {}, successors = ["codex", "grok"], handoff = async () => ({ intentId: "intent-1",
  state: "waiting" }), held = { quotaPoolId: "registration:m1:claude", limitedUntil: "2026-10-01T13:00:00.000Z" },
  ownHandoff = undefined } = {}) {
  const calls = { limits: [], handoffs: [] };
  const directory = { cacheMode: "disabled", async transaction(_context, callback) {
    return callback({ async query(statement) {
      calls.limits.push(statement.values);
      return held ? [{ quota_pool_id: held.quotaPoolId, expires_at: held.limitedUntil }] : [];
    } });
  } };
  const repo = new PostgresRegistrationRebornRepository({ cacheMode: "disabled" }, directory, { spaceId: "space", shardId: "s", placementEpoch: 1 });
  repo.locate = async () => ({ key: { spaceId: "space", ownerUserId: "owner", machineId: "m1", harness: "claude" },
    handedOff: false, ...located });
  repo.autoHandoffSuccessors = async () => successors;
  repo.messageHandoff = async () => ownHandoff;
  repo.prepareHandoff = async input => { calls.handoffs.push(input); return handoff(input); };
  return { repo, calls };
}

const input = { commandId: "usage-limit-handoff:n1", actorUserId: "owner", channelId: "channel",
  sourceMessageId: "turn-failure:n1", sourceInstanceId: "instance-1", resetsAt: "2026-10-01T13:00:00Z", prompt: "go" };

test("handoff rejects the source Agent even when addressed through a harness alias", async () => {
  for (const [sourceHarness, successorHarness] of [["claude", "claude_code"], ["claude_code", "claude"]]) {
    const { repo } = repository({ located: { key: {
      spaceId: "space", ownerUserId: "owner", machineId: "m1", harness: sourceHarness,
    } } });
    repo.physical = async () => assert.fail("the source Agent must be rejected before launch admission");
    await assert.rejects(PostgresRegistrationRebornRepository.prototype.prepareHandoff.call(repo,
      { ...input, successorHarness }),
      error => error.code === "handoff_same_agent");
  }
});

test("a usage limit only holds the pool until the reset; it hands nothing off itself", async () => {
  const { repo, calls } = repository();
  assert.deepEqual(await repo.holdUsageLimit(input), { limitedUntil: "2026-10-01T13:00:00.000Z" });
  assert.deepEqual(calls.limits, [["owner", "m1", "claude", "2026-10-01T13:00:00.000Z"]]);
  assert.deepEqual(calls.handoffs, []);
  const unheld = repository({ held: null });
  assert.deepEqual(await unheld.repo.holdUsageLimit(input), {});
});

test("only the Instance's owner may report its account used up", async () => {
  const { repo, calls } = repository();
  await assert.rejects(repo.holdUsageLimit({ ...input, actorUserId: "someone-else" }),
    error => error.code === "forbidden");
  assert.deepEqual(calls.limits, []);
});

test("@auto: the first successor on the machine that accepts takes the directory", async () => {
  const { repo, calls } = repository({ handoff: async ({ successorHarness }) => {
    if (successorHarness === "codex") throw new RegistrationAccessError("registration_environment_missing", 409);
    return { intentId: "intent-2", state: "waiting" };
  } });
  const result = await repo.prepareAutoHandoff(input);
  assert.deepEqual(calls.limits, [], "an ordinary handoff never touches quota");
  assert.deepEqual(calls.handoffs.map(call => [call.successorHarness, call.sourceMessageId, call.commandId]),
    [["codex", "turn-failure:n1", "usage-limit-handoff:n1:codex"], ["grok", "turn-failure:n1", "usage-limit-handoff:n1:grok"]]);
  assert.deepEqual(result, { outcome: "handed_off", successorHarness: "grok", intentId: "intent-2", state: "waiting",
    refusals: [{ harness: "codex", code: "registration_environment_missing" }] });
});

test("a source that cannot move hands nothing off", async () => {
  for (const [located, outcome] of [[{ handedOff: true }, "source_transferred"],
    [{ routedAs: "management_space" }, "not_transferable"], [{ routedAs: "direct_conversation" }, "not_transferable"]]) {
    const { repo, calls } = repository({ located });
    assert.equal((await repo.prepareAutoHandoff(input)).outcome, outcome);
    assert.deepEqual(calls.handoffs, []);
  }
});

test("a pending continuation stops the search; no successor is reported as such", async () => {
  const pending = repository({ handoff: async () => { throw new RegistrationAccessError("reborn_pending", 409); } });
  assert.deepEqual(await pending.repo.prepareAutoHandoff(input), { outcome: "refused", code: "reborn_pending", refusals: [] });
  assert.equal(pending.calls.handoffs.length, 1);

  const none = repository({ successors: [] });
  assert.deepEqual(await none.repo.prepareAutoHandoff(input), { outcome: "no_successor", refusals: [] });
});

test("an unexpected failure is not swallowed as a refusal", async () => {
  const { repo } = repository({ handoff: async () => { throw new Error("connection reset"); } });
  await assert.rejects(repo.prepareAutoHandoff(input), /connection reset/);
});

test("with nobody on the machine, a repository-backed source names its repository", async () => {
  const { repo } = repository({ successors: [], located: { remoteRepo: "acme/app" } });
  assert.deepEqual(await repo.prepareAutoHandoff(input), { outcome: "no_successor", refusals: [], repository: "acme/app" });
  // A handed-off directory is a same-machine move; it never names one.
  const moved = repository({ located: { remoteRepo: "acme/app" } });
  assert.equal((await moved.repo.prepareAutoHandoff(input)).repository, undefined);
});

test("the same message interpreted again gets its own handoff back, not a refusal", async () => {
  const own = { entityId: "instance-2", intentId: "intent-1", state: "spawned", reused: true };
  // The source is already fenced to this message's successor.
  const done = repository({ located: { handedOff: true }, ownHandoff: own });
  assert.deepEqual(await done.repo.prepareAutoHandoff(input),
    { outcome: "handed_off", intentId: "intent-1", state: "spawned", refusals: [] });
  assert.deepEqual(calls(done), []);
  // Still pending, possibly with a successor tried while quotas read differently.
  const pending = repository({ ownHandoff: { ...own, state: "waiting" },
    handoff: async () => { throw new RegistrationAccessError("reborn_pending", 409); } });
  assert.deepEqual(await pending.repo.prepareAutoHandoff(input),
    { outcome: "handed_off", intentId: "intent-1", state: "waiting", refusals: [] });
  // A named handoff replayed after the fence returns the same intent.
  const named = repository({ located: { handedOff: true }, ownHandoff: own });
  assert.deepEqual(await PostgresRegistrationRebornRepository.prototype.prepareHandoff.call(named.repo,
    { ...input, successorHarness: "codex" }), own);
  // Another message's handoff still refuses.
  const other = repository({ located: { handedOff: true } });
  assert.equal((await other.repo.prepareAutoHandoff(input)).outcome, "source_transferred");
  await assert.rejects(PostgresRegistrationRebornRepository.prototype.prepareHandoff.call(other.repo,
    { ...input, successorHarness: "codex" }), error => error.code === "handoff_source_transferred");
});

test("a repo Instance is reborn or handed off whatever its Space's GitHub connection version", async () => {
  // A Run launched while connector authorizations were stored, pinned to a
  // connection version that has since advanced (a Check, re-install or edit).
  for (const connectorRepositoryAuthorization of [
    { connectionId: "space:github", connectionVersion: 3, repository: "LambdaLabsHQ/xmatrix" }, null, { stale: true }]) {
    const statements = [];
    const database = { cacheMode: "disabled", async transaction(_context, callback) {
      return callback({ async query(statement) {
        statements.push(statement.name);
        return [{ run_id: "run-1", channel_instance_id: 2, owner_user_id: "owner", workspace_canonical_cwd: ".xmatrix-management/k",
          b_space: "space", b_owner: "owner", b_machine: "m1", b_harness: "claude",
          metadata_json: { remoteRepo: "LambdaLabsHQ/xmatrix", managedWorkspaceKey: "k", connectorRepositoryAuthorization } }];
      } });
    } };
    const repo = new PostgresRegistrationRebornRepository(database, { cacheMode: "disabled" },
      { spaceId: "space", shardId: "s", placementEpoch: 1 }, async () => assert.fail("a continuation reads no repository catalog"));
    for (const operation of ["reborn", "handoff"]) {
      const located = await PostgresRegistrationRebornRepository.prototype.locate.call(repo, input, operation);
      assert.equal(located.remoteRepo, "LambdaLabsHQ/xmatrix");
      assert.equal(Object.hasOwn(located, "repositoryAuthorization"), false);
    }
    assert.deepEqual(statements, ["registration_reborn_predecessor_v2", "registration_reborn_predecessor_v2"]);
  }
});

function calls({ calls: recorded }) { return recorded.handoffs; }
