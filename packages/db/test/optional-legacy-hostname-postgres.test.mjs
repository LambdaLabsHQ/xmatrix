import { isolatedPostgres, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { recordMachineRunTerminalReport, PostgresMachineRunTerminalReportRepository }
  from "../dist/machine-run-terminal-reports.js";

integration("optional legacy observations preserve Machine scope and terminal report lease evidence", async () => {
  const isolated = await isolatedPostgres("optional_hostname", { migrate: false, runtimeRole: false });
  const { client } = isolated;
  try {
    await client.query("CREATE SCHEMA data");
    const tables = ["agent_launches", "agent_reborn_intents", "machine_daemon_commands", "machine_daemons", "machine_run_routes"];
    for (const table of tables) await client.query(`CREATE TABLE data.${table}
      (owner_user_id text NOT NULL,machine_id text NOT NULL,host_id text NOT NULL,
       UNIQUE(owner_user_id,machine_id,host_id));
      INSERT INTO data.${table} VALUES ('owner','machine','observed-host')`);
    await client.query(await readFile(new URL("../migrations/0092_expand_machine_run_terminal_reports.sql", import.meta.url), "utf8"));
    const expansion = await readFile(new URL("../migrations/0134_expand_optional_legacy_hostname.sql", import.meta.url), "utf8");
    await client.query(expansion); await client.query(expansion);
    for (const table of tables) {
      await client.query(`INSERT INTO data.${table} VALUES ('owner','without-hostname',NULL)`);
      assert.equal((await client.query(`SELECT host_id FROM data.${table} WHERE machine_id='machine'`)).rows[0].host_id,"observed-host");
      await assert.rejects(client.query(`INSERT INTO data.${table} VALUES ('owner',NULL,NULL)`), /not-null/);
    }
    await client.query("ALTER TABLE data.machine_run_terminal_reports ADD COLUMN hostname text");
    const database = { transaction: async (_context, callback) => {
      await client.query("BEGIN");
      try {
        const value = await callback({ query: async query => {
          const { rows } = await client.query(query.text, query.values);
          assert.ok(rows.length <= query.maxRows, query.name); return rows;
        } });
        await client.query("COMMIT"); return value;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    } };
    const input = { runId: "run",eventType: "machine_run_exited",ownerUserId: "owner",ownerEmail: "owner@example.test",
      machineId: "machine",hostId: "",channelId: "channel",connectionEpoch: 4,requestId: "first",payload: { executionKey: "execution" } };
    await database.transaction({}, tx => recordMachineRunTerminalReport(tx,input));
    await database.transaction({}, tx => recordMachineRunTerminalReport(tx,{...input,requestId:"retry",payload:{executionKey:"other"}}));
    assert.deepEqual((await client.query("SELECT host_id,request_id,payload_json FROM data.machine_run_terminal_reports")).rows,
      [{host_id:null,request_id:"first",payload_json:{executionKey:"execution"}}]);
    const repository = new PostgresMachineRunTerminalReportRepository(database);
    const [claimed] = await repository.claim("worker","channel");
    assert.equal(claimed.hostId,"");
    assert.equal(claimed.machineId,"machine");
    assert.equal(claimed.connectionEpoch,4);
    await repository.settle({report:{...claimed,leaseOwner:"other"},finalized:true});
    assert.equal((await client.query("SELECT state FROM data.machine_run_terminal_reports")).rows[0].state,"pending");
    await repository.settle({report:claimed,finalized:true});
    assert.equal((await client.query("SELECT state FROM data.machine_run_terminal_reports")).rows[0].state,"finalized");
  } finally {
    await isolated.close();
  }
});
