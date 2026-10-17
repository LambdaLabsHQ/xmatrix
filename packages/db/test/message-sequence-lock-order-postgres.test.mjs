import assert from "node:assert/strict";
import { Client } from "pg";
import { connectionString, integration } from "./postgres-database.fixture.mjs";
import { effectFixture } from "./dingtalk-effects.fixture.mjs";

/**
 * Both transactions of an append lock the Channel's sequence counter before
 * the command's reservation: reserving takes the counter, then inserts the
 * reservation, whose unique check waits on any update of that key. A commit
 * that updated the reservation first and then waited on the counter closed a
 * cycle with a duplicate of its command reserving at the same moment
 * (40P01 while inserting into message_sequence_reservations, welcome.e2e).
 */
integration("a message commit waits on its Channel counter before it touches its reservation", async () =>
  effectFixture(async (f) => {
    const cap = await f.cap();
    const input = await f.appendInput(cap);
    const counter = new Client({ connectionString });
    const probe = new Client({ connectionString });
    await counter.connect();
    await probe.connect();
    try {
      await counter.query("BEGIN");
      await counter.query(`SELECT 1 FROM data.channel_message_sequences
        WHERE space_id=$1 AND channel_id=$2 FOR UPDATE`, [f.spaceId, f.channelId]);
      const appending = f.messages.append(input, cap);
      let failed; appending.catch((error) => { failed = error; });
      const deadline = Date.now() + 3000;
      for (;;) {
        // Who waits on the session holding the counter (the statement text is
        // longer than pg_stat_activity keeps).
        const waiting = (await probe.query(`SELECT 1 FROM pg_stat_activity
          WHERE $1::int = ANY(pg_blocking_pids(pid))`, [counter.processID])).rows;
        if (waiting.length) break;
        assert.ok(!failed && Date.now() < deadline, `the commit should wait on the held Channel counter: ${failed?.message}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // While it waits there, the reservation is not yet locked by it: a
      // reserving duplicate holding the counter can always finish.
      await probe.query("BEGIN");
      await probe.query(`SELECT 1 FROM data.message_sequence_reservations
        WHERE space_id=$1 AND command_id=$2 FOR UPDATE NOWAIT`, [f.spaceId, input.commandId]);
      await probe.query("ROLLBACK");
      await counter.query("ROLLBACK");
      assert.equal((await appending).messageId, input.messageId);
      const reservation = (await probe.query(`SELECT state FROM data.message_sequence_reservations
        WHERE space_id=$1 AND command_id=$2`, [f.spaceId, input.commandId])).rows[0];
      assert.equal(reservation.state, "committed");
    } finally {
      await counter.query("ROLLBACK").catch(() => {});
      await counter.end();
      await probe.end();
    }
  }));
