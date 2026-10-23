import assert from "node:assert/strict";
import { MachineControlError } from "@xmatrix/db";
import { integration, isolatedPostgres, postgresDatabase } from "../../db/test/postgres-database.fixture.mjs";
import { INSTANCE_IDLE_SLEEP_MS, reconcileIdleSleeps } from "../src/instance-idle-sleep.ts";

// The old test supplied the row a destructive UPDATE was supposed to return.
// Only PostgreSQL can establish which deadline actually survives that query.
integration("sleep handoff preserves its deadline until durable acceptance, with stable retries and bounded recovery", async () => {
  const fixture = await isolatedPostgres("idle_sleep_handoff");
  const { client, run } = fixture;
  const database = postgresDatabase(client);
  const first = "2026-01-01 00:00:00.123456+00";
  const next = "2026-01-02 00:00:00.654321+00";
  const channel = "channel-" + "c".repeat(230);
  const runId = `${channel}:1#1`;
  const setDue = (at, id = runId) => run("UPDATE data.runs SET idle_sleep_at=$2::timestamptz WHERE run_id=$1", [id, at]);
  const due = async () => (await run("SELECT idle_sleep_at::text AS at FROM data.runs WHERE run_id=$1", [runId]))[0].at;
  const reconcile = issue => reconcileIdleSleeps({}, database, channel, issue);
  const commands = [];
  const record = async command => { commands.push(command); };
  try {
    await run(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
      VALUES ($1,'owner',$3,'running',1,$2,now(),now())`,
    [runId, { machineId: "machine:a", hostId: "host-a", executionKey: "execution-1", resumeSessionKey: "session" }, channel]);
    await run(`INSERT INTO data.instances
      (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
      VALUES ($3,$1,$2,1,'online',1,now(),now())`, [runId, channel, `${channel}:1`]);
    await setDue(first);

    await assert.rejects(reconcile(async command => {
      await record(command);
      throw new Error("acceptance response lost");
    }), /acceptance response lost/u);
    assert.equal(await due(), first, "a failed or uncertain handoff remains due for coordinator recovery");
    await reconcile(record);
    assert.deepEqual(commands[1], commands[0], "recovery repeats the exact command, even after a lost acceptance response");
    assert.equal(commands[0].payload.idleForMillis, INSTANCE_IDLE_SLEEP_MS);
    assert.equal(commands[0].payload.runId, runId);
    assert.equal(commands[0].payload.executionKey, "execution-1");
    assert.equal(commands[0].payload.instanceId, `${channel}:1`);
    assert.ok(commands[0].controlId.length <= 200);
    assert.equal(await due(), null, "durable acceptance clears the exact deadline including microseconds");
    await reconcile(record);
    assert.equal(commands.length, 2, "a completed handoff is no longer due");

    await setDue(first);
    await reconcile(async command => {
      await reconcile(async overlapping => {
        assert.deepEqual(overlapping, command, "overlapping passes hand off the same durable command");
      });
    });
    assert.equal(await due(), null);

    await setDue(next);
    await reconcile(async command => { await record(command); await setDue(first); });
    assert.notEqual(commands[2].controlId, commands[1].controlId, "a new resting period has its own command identity even for a long Run id");
    assert.equal(await due(), first, "late acceptance cannot clear a replacement deadline");
    await reconcile(async () => { throw new MachineControlError("sleep_unavailable", 409, "old daemon"); });
    assert.equal(await due(), null, "an incapable daemon is left alone");

    // Its conversation co-writes a page live: the Run stays on the page however long people pause.
    await run(`INSERT INTO data.page_co_writing (space_id,page_id,conversation_id,started_by_user_id,started_at)
      VALUES ('space','page',$1,'owner',now())`, [channel]);
    await setDue(first);
    await reconcile(async () => { assert.fail("a Run co-writing a page live is not put to sleep"); });
    assert.equal(await due(), null, "its resting period passes without sleep");
    // Ended, or started long enough ago, co-writing no longer keeps it awake.
    await run("UPDATE data.page_co_writing SET started_at=now()-interval '25 hours'");
    await setDue(first);
    await reconcile(record);
    assert.equal(commands.length, 4, "a co-writing started over a day ago keeps it awake no longer");
    await run("UPDATE data.page_co_writing SET started_at=now(), ended_at=now()");
    await setDue(first);
    await reconcile(record);
    assert.equal(commands.length, 5, "an ended co-writing keeps it awake no longer");

    await run(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at,idle_sleep_at)
      SELECT $2||':'||(n+1)||'#1','owner',$2,'exited',1,'{}',now(),now(),$1::timestamptz
      FROM generate_series(1,101) n`, [first, channel]);
    await reconcile(async () => { assert.fail("ended Runs must never be issued sleep"); });
    assert.equal(Number((await run("SELECT count(*) FROM data.runs WHERE idle_sleep_at IS NOT NULL"))[0].count), 1,
      "one pass handles at most 100 rows rather than mutating an unbounded set");
    await reconcile(record);
    assert.equal(Number((await run("SELECT count(*) FROM data.runs WHERE idle_sleep_at IS NOT NULL"))[0].count), 0);
  } finally { await fixture.close(); }
});
