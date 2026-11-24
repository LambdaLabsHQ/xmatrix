import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresMachineControlRepository, readLogExcerptStatus } from "../dist/index.js";

integration("a log excerpt needs the owner and a capable daemon, and keeps only a bounded redacted answer", async () => {
  const fixture = await isolatedPostgres("log_excerpt", { shard: true });
  const { session } = fixture;
  try {
    const controls = new PostgresMachineControlRepository(session);
    const machine = { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "logs-machine",
      hostId: "logs-host", daemonId: "logs-daemon" };
    const principal = { kind: "machine", id: "machine-daemon:owner:logs-machine:logs-host",
      ownerUserId: "owner", machineId: "logs-machine", hostId: "logs-host" };
    const connect = capabilities => controls.command({ ...machine, commandId: randomUUID(), action: "connect",
      principal, capabilities, payload: {}, metadata: {} });
    const issue = (requestId, patch = {}, user = "owner") => controls.command({ ...machine, commandId: randomUUID(),
      action: "issue", principal: { kind: "user", id: user }, controlId: requestId, commandType: "log_excerpt",
      payload: { type: "machine_log_excerpt", requestId, ...patch } });
    const claim = connected => controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: connected.connectionEpoch, commandTypes: [], payload: {} });
    const read = (controlId, ownerUserId = "owner") =>
      readLogExcerptStatus(session, { requestId: randomUUID(), ownerUserId, controlId });
    const id = () => `logs:${randomUUID()}`;

    await connect([]);
    await assert.rejects(issue(id()), error => error.code === "log_excerpt_unavailable",
      "a daemon that cannot read its logs is not asked");
    let connected = await connect(["machine_log_excerpt_v1"]);
    await assert.rejects(issue(id(), {}, "intruder"), error => error.code === "forbidden");
    await assert.rejects(issue(id(), { path: "/etc/passwd" }), error => error.code === "invalid_log_excerpt");
    await assert.rejects(issue("worktree:00000000-0000-4000-8000-000000000000"),
      error => error.code === "invalid_log_excerpt");

    const requestId = id();
    await issue(requestId);
    assert.equal((await read(requestId)).status, "queued");
    assert.equal((await read(requestId, "intruder")).status, "missing", "only the owner reads it");
    const plain = await connect([]);
    assert.equal((await claim(plain)).commands.length, 0, "a daemon that cannot answer never leases it");
    connected = await connect(["machine_log_excerpt_v1"]);
    const claimed = await claim(connected);
    assert.deepEqual(claimed.commands.map(command => command.payload.requestId), [requestId]);
    const complete = result => controls.command({ ...machine, commandId: randomUUID(),
      action: "complete", principal, connectionEpoch: connected.connectionEpoch, controlId: requestId,
      eventType: "machine_log_excerpt_result", relayLease: claimed.commands[0].payload.relayLease,
      payload: { type: "machine_log_excerpt_result", requestId, result } });
    for (const result of [
      { status: "succeeded", excerpt: "x".repeat(16_001) },
      { status: "succeeded", excerpt: "\u001b[31mred\u001b[0m" },
      { status: "succeeded" },
      { status: "failed", excerpt: "tail", error: "no" },
      { status: "succeeded", excerpt: "tail", path: "/home/owner/.config/xmatrix/logs" },
    ]) {
      await assert.rejects(complete(result), error => error.code === "machine_command_result_mismatch");
    }
    const excerpt = "== logs/daemon.err ==\n2026-11-24 daemon reconnected\tafter 3s\n⚠ spawn failed in ~/work";
    await complete({ status: "succeeded", excerpt });
    const answered = await read(requestId);
    assert.deepEqual([answered.status, answered.excerpt], ["succeeded", excerpt]);
    assert.ok(answered.completedAt);
  } finally { await fixture.close(); }
});
