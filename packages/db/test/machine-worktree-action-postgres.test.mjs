import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresMachineControlRepository, readLatestWorktreeListing, readWorktreeActionStatus } from "../dist/index.js";

integration("worktree actions need the owner and a capable daemon, and answer exactly what was asked", async () => {
  const fixture = await isolatedPostgres("worktree_action", { shard: true });
  const { session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const machine = { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "worktree-machine",
      hostId: "worktree-host", daemonId: "worktree-daemon" };
    const principal = { kind: "machine", id: "machine-daemon:owner:worktree-machine:worktree-host",
      ownerUserId: "owner", machineId: "worktree-machine", hostId: "worktree-host" };
    const connect = capabilities => controls.command({ ...machine, commandId: randomUUID(), action: "connect",
      principal, capabilities, payload: {}, metadata: {} });
    const issue = (requestId, patch = {}, user = "owner") => controls.command({ ...machine, commandId: randomUUID(),
      action: "issue", principal: { kind: "user", id: user }, controlId: requestId, commandType: "worktree_action",
      payload: { type: "machine_worktree_action", requestId, action: "list", ...patch } });
    const claim = connected => controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: connected.connectionEpoch, commandTypes: [], payload: {} });
    const read = controlId => readWorktreeActionStatus(session, { requestId: randomUUID(), ownerUserId: "owner", controlId });
    const id = () => `worktree:${randomUUID()}`;

    await connect([]);
    await assert.rejects(issue(id()), error => error.code === "worktree_action_unavailable");
    let connected = await connect(["machine_worktree_action_v1"]);
    await assert.rejects(issue(id(), {}, "intruder"), error => error.code === "forbidden");
    await assert.rejects(issue(id(), { action: "purge" }), error => error.code === "invalid_worktree_action");
    await assert.rejects(issue(id(), { action: "reclaim" }), error => error.code === "invalid_worktree_action");
    await assert.rejects(issue(id(), { command: "rm -rf /" }), error => error.code === "invalid_worktree_action");

    const listId = id();
    await issue(listId);
    const queued = await read(listId);
    assert.deepEqual([queued.action, queued.status], ["list", "queued"]);
    assert.equal((await readWorktreeActionStatus(session, { requestId: randomUUID(), ownerUserId: "intruder",
      controlId: listId })).status, "missing");
    // A daemon that cannot parse the action never leases it.
    const plain = await connect([]);
    assert.equal((await claim(plain)).commands.length, 0);
    connected = await connect(["machine_worktree_action_v1"]);
    const claimed = await claim(connected);
    assert.deepEqual(claimed.commands.map(command => command.payload.requestId), [listId]);
    const complete = (controlId, lease, result) => controls.command({ ...machine, commandId: randomUUID(),
      action: "complete", principal, connectionEpoch: connected.connectionEpoch, controlId,
      eventType: "machine_worktree_action_result", relayLease: lease,
      payload: { type: "machine_worktree_action_result", requestId: controlId, result } });
    const inventory = { capturedAt: "2026-10-08T21:00:00Z", foreignAutoReclaim: false, trees: [
      { path: "/tmp/fix", origin: "manual", locked: false, missing: false, inUse: false, idleSecs: 900_000, sizeBytes: 4096 }] };
    await assert.rejects(complete(listId, claimed.commands[0].payload.relayLease, { action: "reclaim", status: "succeeded" }),
      error => error.code === "machine_command_result_mismatch");
    await complete(listId, claimed.commands[0].payload.relayLease, { action: "list", status: "succeeded", inventory });
    assert.deepEqual((await read(listId)).result.inventory, inventory);
    const latest = await readLatestWorktreeListing(session, { requestId: randomUUID(), ownerUserId: "owner",
      machineId: machine.machineId });
    assert.equal(latest.controlId, listId);

    // Reclaim reports only the paths it was asked about.
    const reclaimId = id();
    await issue(reclaimId, { action: "reclaim", paths: ["/tmp/fix"] });
    const second = await claim(connected);
    await assert.rejects(complete(reclaimId, second.commands[0].payload.relayLease, { action: "reclaim", status: "succeeded",
      reclaimed: [{ path: "/home/owner", snapshotted: false }] }), error => error.code === "machine_command_result_mismatch");
    await complete(reclaimId, second.commands[0].payload.relayLease, { action: "reclaim", status: "succeeded",
      reclaimed: [{ path: "/tmp/fix", snapshotted: true }], kept: [] });
    assert.deepEqual((await read(reclaimId)).result.reclaimed, [{ path: "/tmp/fix", snapshotted: true }]);
  } finally { await fixture.close(); }
});
