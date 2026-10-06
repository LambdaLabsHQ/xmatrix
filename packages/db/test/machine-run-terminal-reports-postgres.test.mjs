import { connectionString as url, integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { recordMachineRunTerminalReport, PostgresMachineRunTerminalReportRepository }
  from "../dist/machine-run-terminal-reports.js";

// Runs against a fully migrated database (`scripts/migrate.mjs apply`).

const database = postgresConnections;
integration("a terminal report is recorded once, leased to one finalizer, and retried until finalized", async () => {
  const setup = new Client({ connectionString: url }); await setup.connect();
  const sql = (text, values) => setup.query(text, values);
  const id = `terminal-${process.pid}-${Date.now()}`;
  const db = database();
  const input = (requestId, payload = {}) => ({ runId: `run-${id}`, eventType: "machine_run_exited",
    ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "machine", hostId: "host",
    channelId: "channel", connectionEpoch: 7, requestId, payload: { runId: `run-${id}`, ...payload } });
  try {
    await db.transaction({}, tx => recordMachineRunTerminalReport(tx, input("first", { exitCode: 1 })));
    // A resent report changes nothing: the first evidence wins.
    await db.transaction({}, tx => recordMachineRunTerminalReport(tx, input("resent", { exitCode: 2 })));
    const rows = (await sql(`SELECT request_id,payload_json->>'exitCode' AS code,state FROM
      data.machine_run_terminal_reports WHERE run_id=$1`, [`run-${id}`])).rows;
    assert.deepEqual(rows, [{ request_id: "first", code: "1", state: "pending" }]);

    const repository = new PostgresMachineRunTerminalReportRepository(db);
    const mine = (claimed) => claimed.filter(value => value.runId === `run-${id}`);
    const [claimed] = mine(await repository.claim("worker-a", "channel"));
    assert.equal(claimed.attempts, 1);
    assert.deepEqual(mine(await repository.claim("worker-b", "channel")), [], "a leased report is not claimed twice");

    // Another worker's lease cannot settle it.
    await repository.settle({ report: { ...claimed, leaseOwner: "worker-b" }, finalized: true });
    assert.equal((await sql(`SELECT state FROM data.machine_run_terminal_reports WHERE run_id=$1`,
      [`run-${id}`])).rows[0].state, "pending");

    await repository.settle({ report: claimed, finalized: false, errorCode: "Router unavailable" });
    const retry = (await sql(`SELECT state,lease_owner,last_error_code,
      next_attempt_at>clock_timestamp() AS backed_off FROM data.machine_run_terminal_reports WHERE run_id=$1`,
    [`run-${id}`])).rows[0];
    assert.deepEqual(retry, { state: "pending", lease_owner: null, last_error_code: "Router unavailable",
      backed_off: true });
    assert.deepEqual(mine(await repository.claim("worker-c", "channel")), [], "a failed report waits out its backoff");

    await sql(`UPDATE data.machine_run_terminal_reports SET next_attempt_at=clock_timestamp() WHERE run_id=$1`,
      [`run-${id}`]);
    const [again] = mine(await repository.claim("worker-d", "channel"));
    assert.equal(again.attempts, 2);
    await repository.settle({ report: again, finalized: true });
    assert.equal((await sql(`SELECT state FROM data.machine_run_terminal_reports WHERE run_id=$1`,
      [`run-${id}`])).rows[0].state, "finalized");

    // Finalized reports are kept a week, then pruned.
    assert.equal(await repository.pruneFinalized("channel") >= 0, true);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM data.machine_run_terminal_reports WHERE run_id=$1`,
      [`run-${id}`])).rows[0].n, 1);
    await sql(`UPDATE data.machine_run_terminal_reports SET finalized_at=clock_timestamp()-interval '8 days'
      WHERE run_id=$1`, [`run-${id}`]);
    await repository.pruneFinalized("channel");
    assert.equal((await sql(`SELECT count(*)::int AS n FROM data.machine_run_terminal_reports WHERE run_id=$1`,
      [`run-${id}`])).rows[0].n, 0);
  } finally {
    await setup.end();
  }
});
