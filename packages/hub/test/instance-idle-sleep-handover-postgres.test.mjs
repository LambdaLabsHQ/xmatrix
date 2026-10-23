import assert from "node:assert/strict";
import { integration, isolatedPostgres, seedTestSpacePlacement } from "../../db/test/postgres-database.fixture.mjs";
import { PostgresAgentInstancePort } from "../src/runtime-transport/postgres-agent-instance-port.ts";
import { channelInstanceSession } from "./support/agent-instance-port.mjs";

// The DB owner's test protects the idle deadline itself. This crosses the
// production socket composition and real commits: a failed coordinator handoff
// must not be forgotten just because the next write is already committed.
for (const failure of ["transport", "refused"]) {
  integration(`presence retries a ${failure} idle-sleep handoff after the database committed`, async (t) => {
    const f = await isolatedPostgres("idle_handover", { shard: true });
    try {
      const at = new Date().toISOString();
      await seedTestSpacePlacement(f.client, "space", at);
      await f.run(`INSERT INTO control.channel_space_directory (channel_id,space_id,updated_at)
        VALUES ('channel','space',$1)`, [at]);
      await f.run(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
        VALUES ('channel:2#1','owner','channel','running',1,$1,$2,$2)`,
      [{ machineId: "machine", executionKey: "execution", resumeSessionKey: "resume" }, at]);
      await f.run(`INSERT INTO data.instances
        (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
        VALUES ('channel:2','channel:2#1','channel',2,'idle',1,$1,$1)`, [at]);
      const calls = [];
      const transportError = Object.assign(new Error("coordinator transport lost"), { retryable: true });
      const logged = t.mock.method(console, "error", () => {});
      const port = PostgresAgentInstancePort.fromEnv({
        env: { RELAY_POSTGRES: { connectionString: f.url.toString() }, RELAY_POSTGRES_SHARD_ID: "shard-0",
          RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL: {
            idFromName: name => name,
            get: id => ({ async fetch(url, init) {
              calls.push({ id, url, body: JSON.parse(init.body) });
              if (calls.length === 1) {
                if (failure === "transport") throw transportError;
                return new Response(null, { status: 503 });
              }
              return Response.json({ ok: true });
            } }),
          } },
        history: { async join() {}, async leave() {}, async replay() {}, async history() {} },
        signals: { async publish() {} },
      });
      const session = { ...channelInstanceSession(), run: { ...channelInstanceSession().run,
        runId: "channel:2#1", instanceId: "channel:2", instanceStatus: "idle" } };
      const presence = (status, updatedAtMillis) => port.execute(session, {
        type: "presence_update", status, runtimeState: { status: status === "busy" ? "running" : "idle", updatedAtMillis },
      });
      const deadline = async () => (await f.run("SELECT idle_sleep_at::text AS at FROM data.runs WHERE run_id='channel:2#1'"))[0].at;
      await presence("idle", 1);
      const firstDeadline = await deadline();
      assert.ok(firstDeadline, "the database committed before the handoff failed");
      assert.equal(logged.mock.calls.length, 1, "a failed handoff is still reported");
      await presence("idle", 1);
      assert.equal(calls.length, 2, "the unchanged presence must retry the handoff");
      if (failure === "transport") {
        const reported = logged.mock.calls.flatMap(call => call.arguments).find(value => value instanceof Error);
        assert.equal(reported?.cause, transportError);
      }
      assert.deepEqual(calls[1], calls[0], "the retry targets the same Channel and work");
      assert.equal(calls[1].id, "channel");
      assert.deepEqual(calls[1].body.work, ["idleSleep"]);
      assert.equal(await deadline(), firstDeadline, "a retry preserves the idle window");
      await presence("idle", 1);
      assert.equal(calls.length, 2, "a successful handoff deduplicates unchanged presence");
      await presence("busy", 2);
      assert.equal(await deadline(), null, "work withdraws the deadline");
      assert.equal(calls.length, 2, "withdrawal needs no sleep wake");
      await presence("idle", 3);
      assert.ok(await deadline());
      assert.equal(calls.length, 3, "the next resting period hands off again");
    } finally { await f.close(); }
  });
}
