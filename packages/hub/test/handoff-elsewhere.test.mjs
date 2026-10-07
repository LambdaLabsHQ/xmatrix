import assert from "node:assert/strict";
import test from "node:test";

import { handoffBranch, launchHandoffSuccessorElsewhere } from "../src/handoff-elsewhere.ts";

/**
 * A handoff the source's machine cannot take: its daemon stops it and pushes
 * its whole checkout to a handoff branch, then a successor starts from that
 * branch on any machine but the source's own registration.
 */

const commit = "a".repeat(40);

function fixture({ targets, stop, dispatch, harness } = {}) {
  const calls = [];
  const input = { commandId: "handoff-elsewhere:n1", actorUserId: "owner", channelId: "channel",
    sourceMessageId: "message-1", sourceRunId: "run-1", sourceInstanceId: "instance-1", sourceAddress: "@claude:3",
    repository: "acme/app", request: "finish the review", ...(harness ? { harness } : {}) };
  const dependencies = {
    dispatch: async request => {
      calls.push(["dispatch", request]);
      return dispatch ? dispatch(request) : { agentName: "claude", runId: "run-2", instanceId: "instance-2",
        launchId: "launch-2", hostId: "host-b", reused: false };
    },
    intervention: context => {
      calls.push(["intervention", context]);
      return {
        async listKillTargets(channelId, source) { calls.push(["list", channelId, source]); return targets ?? [
          { runId: "run-0", instanceId: "instance-0", mentionTarget: "claude:1" },
          { runId: "run-1", instanceId: "instance-1", mentionTarget: "claude:3" },
        ]; },
        async issueHandoffStop(...args) {
          calls.push(["stop", ...args]);
          return stop ? stop(...args) : { stopped: true, handoffExport: { branch: args[4].branch, state: "pushed",
            commit, base: "b".repeat(40), dirty: true } };
        },
      };
    },
  };
  return { calls, input, dependencies };
}

test("the source stops and pushes its checkout, then a successor of the named harness starts from that branch", async () => {
  const f = fixture({ harness: "claude" });
  const branch = await handoffBranch(f.input.commandId);
  assert.match(branch, /^xmatrix\/handoff\/[0-9a-f]{16}$/u);
  const result = await launchHandoffSuccessorElsewhere({}, f.input, f.dependencies);
  assert.deepEqual(f.calls.map(call => call[0]), ["intervention", "list", "stop", "dispatch"]);
  const stop = f.calls.find(call => call[0] === "stop");
  assert.equal(stop[1].runId, "run-1");
  assert.equal(stop[2], "handoff-stop:run-1");
  assert.deepEqual(f.calls.find(call => call[0] === "list")[2], { instanceId: "instance-1", runId: "run-1" });
  assert.match(stop[3], /@claude:3 handed off/);
  assert.deepEqual(stop[5], { branch, channelId: "channel" });
  assert.ok(stop[6] <= 20_000, "a Worker's background work cannot wait minutes for the push");
  const dispatch = f.calls.find(call => call[0] === "dispatch")[1];
  assert.equal(dispatch.commandId, "handoff-elsewhere:n1");
  assert.equal(dispatch.actorUserId, "owner");
  assert.deepEqual(dispatch.tags, { repo: "acme/app", harness: "claude" });
  // The source's own registration is excluded; the same harness elsewhere is not.
  assert.equal(dispatch.excludeSourceInstanceId, "instance-1");
  assert.equal(dispatch.presentationMessageId, "message-1");
  assert.equal(dispatch.runMetadata, undefined);
  assert.match(dispatch.body, new RegExp(`git fetch origin ${branch.replaceAll("/", "\\/")}`, "u"));
  assert.match(dispatch.body, /was asked to push its whole checkout/);
  assert.match(dispatch.body, /uncommitted work of/);
  assert.match(dispatch.body, /finish the review/);
  assert.match(dispatch.body, /xmatrix send channel/);
  assert.deepEqual(result, { agentName: "claude" });
  assert.equal(await handoffBranch(f.input.commandId), branch, "a replay names the same branch");
});

test("@auto leaves the harness to routing and is drawn on the handoff message", async () => {
  const f = fixture();
  f.input.sourceMention = "@claude:3:handoff:@auto";
  await launchHandoffSuccessorElsewhere({}, f.input, f.dependencies);
  const dispatch = f.calls.find(call => call[0] === "dispatch")[1];
  assert.deepEqual(dispatch.tags, { repo: "acme/app" });
  assert.equal(dispatch.presentationMessageId, "message-1");
  assert.deepEqual(dispatch.runMetadata, { sourceMention: "@claude:3:handoff:@auto" });
});

test("an unconfirmed stop still starts the successor, told to wait for the branch", async () => {
  const f = fixture({ stop: async () => ({ stopped: false }) });
  const result = await launchHandoffSuccessorElsewhere({}, f.input, f.dependencies);
  assert.equal(result.agentName, "claude");
  const body = f.calls.find(call => call[0] === "dispatch")[1].body;
  assert.match(body, /was asked to push its whole checkout/);
  assert.match(body, /retry for a few minutes/);
});

test("unsaved work still gets a successor, told the work stayed behind", async () => {
  for (const [stop, targets] of [
    [async () => ({ stopped: true })],
    [async (...args) => ({ stopped: true, handoffExport: { branch: args[4].branch, state: "failed", dirty: false,
      error: "remote: Permission denied" } })],
    [async () => ({ stopped: true, handoffExport: { branch: "main", state: "pushed", commit, dirty: true } })],
  ]) {
    const f = fixture({ stop, targets });
    const result = await launchHandoffSuccessorElsewhere({}, f.input, f.dependencies);
    assert.equal(result.agentName, "claude");
    assert.match(f.calls.find(call => call[0] === "dispatch")[1].body, /its directory remains on its machine/);
  }
});

test("a lost wake replays the same launch after the source stops, without another successor", async () => {
  let staged;
  let launches = 0;
  const dispatch = async request => {
    if (staged) {
      assert.deepEqual(request, staged, "a staged command cannot change its request on retry");
      return { agentName: "codex", reused: true };
    }
    staged = structuredClone(request);
    launches++;
    throw new Error("wake response lost after staging");
  };
  const first = fixture({ dispatch });
  await assert.rejects(launchHandoffSuccessorElsewhere({}, first.input, first.dependencies), /wake response lost/);
  // The stopped source is still durably addressable by its exact Run/Instance.
  const replay = fixture({ dispatch });
  assert.equal((await launchHandoffSuccessorElsewhere({}, replay.input, replay.dependencies)).agentName, "codex");
  assert.equal(launches, 1);
  assert.equal(replay.calls.some(call => call[0] === "stop"), true);
});

test("a failed source lookup or stop does not silently start a successor", async () => {
  for (const options of [
    { targets: [] },
    { targets: [{ instanceId: "instance-1", runId: "new-run" }] },
    { stop: async () => { throw new Error("stop issuance failed"); } },
  ]) {
    const f = fixture(options);
    await assert.rejects(launchHandoffSuccessorElsewhere({}, f.input, f.dependencies));
    assert.equal(f.calls.some(call => call[0] === "dispatch"), false);
  }
});

test("pending, successful and failed exports keep the same launch request", async () => {
  let staged;
  const dispatch = async request => {
    if (staged) assert.deepEqual(request, staged);
    else staged = structuredClone(request);
    return { agentName: "codex" };
  };
  for (const stop of [
    async () => ({ stopped: false }),
    undefined,
    async (...args) => ({ stopped: true, handoffExport: { branch: args[4].branch, state: "failed", dirty: false,
      error: "push failed" } }),
  ]) {
    const f = fixture({ dispatch, stop });
    await launchHandoffSuccessorElsewhere({}, f.input, f.dependencies);
  }
});

test("a refused launch rejects with its code for the Channel notice", async () => {
  const f = fixture({ dispatch: async () => { throw Object.assign(new Error("none"), { code: "registration_no_candidate" }); } });
  await assert.rejects(launchHandoffSuccessorElsewhere({}, f.input, f.dependencies),
    error => error.code === "registration_no_candidate");
});
