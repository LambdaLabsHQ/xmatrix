import assert from "node:assert/strict";
import test from "node:test";

import { getMachineName, PostgresPageRepository, readDeletedConversations, readNornProgram, readNornRequest,
  readPageNornPrograms, readWaitingNornPrograms } from "../dist/index.js";
import { PostgresMachineLifecycleRepository } from "../dist/runtime-lifecycle-control.js";
import { activePlacementRow, recordingDatabase } from "./recording-database.fixture.mjs";

const resumable = { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1",
  resumeSessionKey: "resume:owner:channel-1:instance-1" };

function respond(query) {
  if (query.name === "machine_name_get_v1") return [{ name: "Workstation" }];
  if (query.name === "space_placement_resolve_v1") return [activePlacementRow()];
  if (query.name === "page_actor_member_v1") return [{ role: "owner" }];
  if (query.name === "page_tree_access_v3") return [{
    page_id: "page-1", parent_page_id: null, access_mode: "open", head_revision: 3,
    agent_suggest_only: false, title: "Ops", position: "a", updated_at: "2026-11-15T00:00:00.000Z",
    version: 1, published_at: null, summary: null, summary_revision: null, summary_at: null,
    actor_access: null, is_governance: false,
  }];
  if (query.name === "page_tree_reads_v1") return [{ page_id: "page-1", revision: "2" }];
  if (query.name === "norn_program_view_v1") return [{
    channel_id: "channel-1", page_name: "stability", source: "source", state: "running", ledger_json: {},
  }];
  if (query.name === "norn_request_view_v2") return [{ channel_id: "channel-1", holder: "grok", delegated_by_reader: false, request_json: {} }];
  if (query.name === "norn_deleted_conversations_v1") return [{ channel_id: "gone" }];
  if (query.name === "norn_page_programs_v2") return [{
    page_name: "stability", program_id: "program-1", channel_id: "channel-1", source: "source",
    state: "running", runs: 1, ledger_json: {},
  }];
  if (query.name === "norn_waiting_programs_v1") return [];
  if (query.name === "channel_space_directory_resolve_v2") return [{
    channel_id: "channel-1", space_id: "space-1", shard_id: "shard-0", placement_epoch: 1, entity_version: 4,
  }];
  if (query.name === "machine_lifecycle_channel_v2") return [{ channel_id: "channel-1", space_id: "space-1" }];
  if (query.name === "machine_lifecycle_run_lock_v2") return [{
    run_id: "run-1", owner_user_id: "user-1", channel_id: "channel-1", version: 3, status: "running",
    metadata_json: resumable, instance_id: "instance-1", instance_status: "online", instance_version: 2,
    channel_instance_id: 4, agent_name: "Codex",
  }];
  if (query.name === "machine_lifecycle_instance_rest_v1") return [{ instance_id: "instance-1" }];
  if (query.name === "machine_lifecycle_head_advance_v1") return [{ commit_sequence: 15 }];
  if (query.name === "machine_lifecycle_terminal_instances_v1") return [{ instance_id: "instance-1" }];
  return [];
}

test("lock-free name, tree, norn and terminal-instance reads do not open BEGIN (HUB-CZ/CX/D0/D1)", async () => {
  const database = recordingDatabase(respond);
  assert.deepEqual(await getMachineName(database, { requestId: "name", ownerUserId: "user-1", machineId: "machine-1" }),
    { machineId: "machine-1", name: "Workstation" });
  const unnamed = recordingDatabase(() => []);
  assert.deepEqual(await getMachineName(unnamed, { requestId: "missing", ownerUserId: "user-1", machineId: "machine-1" }),
    { machineId: "machine-1", name: null });

  const tree = await new PostgresPageRepository(database).tree({
    requestId: "tree", spaceId: "space-1", principal: { kind: "user", id: "user-1" },
  });
  assert.equal(tree.pages[0].pageId, "page-1");
  assert.equal(tree.pages[0].readRevision, 2);

  const program = await readNornProgram(database, {
    requestId: "program", spaceId: "space-1", programId: "program-1", userId: "user-1",
  });
  assert.equal(program.channelId, "channel-1");
  const request = await readNornRequest(database, {
    requestId: "request", spaceId: "space-1", requestRef: "ref-1", userId: "user-1",
  });
  assert.equal(request.holder, "grok");
  assert.equal((await readDeletedConversations(database, {
    requestId: "deleted", spaceId: "space-1", channelIds: ["gone"],
  })).has("gone"), true);
  assert.equal((await readPageNornPrograms(database, {
    requestId: "page-programs", spaceId: "space-1", pageId: "page-1",
  }))[0].programId, "program-1");
  assert.deepEqual(await readWaitingNornPrograms(database, { requestId: "waiting" }), []);

  const report = await new PostgresMachineLifecycleRepository(database).apply({
    commandId: "life-1", ownerUserId: "user-1", machineId: "machine-1", hostId: "host-1",
    channelId: "channel-1", eventType: "machine_run_exited",
    principal: { kind: "machine", ownerUserId: "user-1", machineId: "machine-1", hostId: "host-1" },
    payload: { runId: "run-1", executionKey: "execution-1" },
  });
  assert.deepEqual(report.terminalInstanceIds, ["instance-1"]);

  const contextsOf = (source) => source.calls.filter((call) => call.context).map((call) => call.context);
  const requireSingleRead = (source, operation) => {
    const matches = contextsOf(source).filter((context) => context.operation === operation);
    assert.ok(matches.length >= 1, operation);
    assert.ok(matches.every((context) => context.statement === "single_read"), `${operation} still opens a transaction`);
  };
  requireSingleRead(database, "machine.get-name");
  requireSingleRead(unnamed, "machine.get-name");
  for (const operation of ["page.tree", "norn.program", "norn.request", "norn.deleted-conversations",
    "norn.page-programs", "norn.waiting-programs", "machine-lifecycle.terminal-instances"]) {
    requireSingleRead(database, operation);
  }
  const writes = contextsOf(database).filter((context) => context.operation === "runtime.machine-lifecycle.machine_run_exited");
  assert.ok(writes.length >= 1);
  assert.ok(writes.every((context) => context.statement !== "single_read"));
  assert.ok(database.sessionCloses >= 5, "each space read closes its session");
});
