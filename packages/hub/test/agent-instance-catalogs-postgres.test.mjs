import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresSpaceControlRepository } from "../../db/dist/index.js";
import { integration } from "../../db/test/postgres-database.fixture.mjs";
import { spaceSecretFixture } from "../../db/test/space-secret-postgres.fixture.mjs";
import { PostgresAgentInstancePort } from "../src/runtime-transport/postgres-agent-instance-port.ts";
import { InstanceRecordCache } from "../src/runtime-transport/instance-record-cache.ts";
import { compactAgentInstancePresentationForHibernation, mergeAgentInstancePresentation } from "../src/runtime-transport/agent-instance-presentation.ts";

// The command producer and real PostgreSQL reader must agree on the complete
// Instance catalog. A recording runtime alone cannot catch either projection loss.
integration("Instance records retain the runtime catalogs on report, cold window and exact reads", async () => {
  const f = await spaceSecretFixture();
  const cache = new InstanceRecordCache();
  const port = PostgresAgentInstancePort.fromEnv({
    env: { RELAY_POSTGRES: { connectionString: process.env.XMATRIX_TEST_POSTGRES_URL }, RELAY_POSTGRES_SHARD_ID: "shard-0" },
    instanceRecords: cache,
    history: { async join() {}, async leave() {}, async replay() {}, async history() {} },
    signals: { async publish() {} },
  });
  const session = { principal: { ownerUserId: f.ids.owner, spaceId: f.ids.space, channelId: f.ids.channel },
    run: { instanceId: f.ids.instance, runId: f.ids.run, channelId: f.ids.channel, connectionVersion: 1,
      instanceStatus: "online", presenceSequence: 0 } };
  const spaces = new PostgresSpaceControlRepository(f.database, "shard-0");
  const catalogs = {
    capabilities: ["model", "effort", "goal"],
    models: [{ id: "native", model: "native-model", displayName: "Native model",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
    commands: [{ token: "/model", label: "Model", mode: "typed", argumentSource: "agent-models" },
      { token: "/compact", label: "Compact", mode: "passthrough" }],
    parameters: [{ id: "fast", label: "Fast", options: ["true", "false"], currentValue: "true" }],
    workspace: { machineId: f.ids.machine, canonicalCwd: "/workspace" },
    runWorktreeBaseRef: "origin/main",
  };
  // Workspace facts come from the connection's Run context, before presence.
  session.presentation = { workspace: catalogs.workspace, runWorktreeBaseRef: catalogs.runWorktreeBaseRef };
  const read = async (knownInstanceIds) => (await spaces.getChannel({ requestId: randomUUID(),
    spaceId: f.ids.space, channelId: f.ids.channel, principal: { kind: "user", id: f.ids.owner },
    ...(knownInstanceIds ? { knownInstanceIds } : {}) })).channel.instanceRecords.find(record => record.id === f.ids.instance);
  const report = async (sequence, presentation) => {
    session.run.presenceSequence = sequence;
    const message = { type: "presence_update", status: "busy", ...presentation };
    await port.execute(session, message);
    // The socket transport retains the merged presentation after executing the port.
    session.presentation = mergeAgentInstancePresentation(session.presentation, message);
    return cache.get(f.ids.instance);
  };
  const checkCatalogs = (record, expected) => {
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(record[key], value, key);
    for (const key of ["activity", "intent", "files", "runtimeState", "privateField"]) {
      assert.equal(Object.hasOwn(record, key), false, key);
    }
  };
  try {
    const written = await report(1, { ...catalogs,
      models: catalogs.models.map(model => ({ ...model, privateField: "PRIVATE" })),
      commands: catalogs.commands.map(command => ({ ...command, privateField: "PRIVATE" })),
      activity: "temporary activity", intent: "temporary intent",
      files: ["temporary file"], runtimeState: { status: "running" }, privateField: "PRIVATE" });
    checkCatalogs(written, catalogs);
    checkCatalogs(await read(), catalogs);
    checkCatalogs(await read([f.ids.instance]), catalogs);
    const changed = { ...catalogs, commands: [{ token: "/review", label: "Review", mode: "passthrough" }] };
    checkCatalogs(await report(2, { commands: changed.commands }), changed);
    checkCatalogs(await read(), changed);
    // Hibernation may omit large catalogs; the persisted observations remain.
    session.presentation = compactAgentInstancePresentationForHibernation(session.presentation);
    const omitted = await report(3, {});
    checkCatalogs(omitted, changed);
    // An attachment past its byte bound restores with no presentation at all.
    session.presentation = undefined;
    const runtimeCatalogs = { capabilities: changed.capabilities, models: changed.models,
      commands: changed.commands, parameters: changed.parameters };
    checkCatalogs(await report(4, { activity: "after restore" }), runtimeCatalogs);
    checkCatalogs(await read(), runtimeCatalogs);
    const empty = { capabilities: [], models: [], commands: [], parameters: [] };
    checkCatalogs(await report(5, empty), empty);
    checkCatalogs(await read(), empty);
    checkCatalogs(await read([f.ids.instance]), empty);
    await report(4, { commands: catalogs.commands });
    checkCatalogs(await read(), empty);
  } finally { await f.close(); }
});
