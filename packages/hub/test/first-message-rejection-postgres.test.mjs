import assert from "node:assert/strict";
import { integration, isolatedPostgres, seedMessageSpace } from "../../db/test/postgres-database.fixture.mjs";
import { PostgresFirstMessageLaunchChoiceRepository } from "@xmatrix/db";
import { summonFirstMessageHarness, dispatchProductMessageLaunches } from "../src/product-message-post-commit.ts";
import { dispatchProductAgentSystemNotice } from "../src/product-agent-mention-authority-adapter.ts";
import { postgresMessageAppend, postgresMessageHistory } from "../src/postgres-message-authority.ts";

// Existing launch tests inject a notice collector, which cannot detect that
// the message authority refuses replies to xMatrix's own system summon.
integration("a refused first-message summon posts one receipt and finishes across a lost acknowledgement", async () => {
  const f = await isolatedPostgres("first_summon_notice", { shard: true });
  const space = "space", channelId = "channel", actorUserId = "owner", first = "first";
  const env = { RELAY_POSTGRES: { connectionString: f.url.toString() }, RELAY_POSTGRES_SHARD_ID: "shard-0" };
  const placement = { spaceId: space, shardId: "shard-0", placementEpoch: 1 };
  const dependencies = { database: f.session, placement };
  const append = (_env, _channel, command) => postgresMessageAppend(env, channelId, command, dependencies);
  const choices = new PostgresFirstMessageLaunchChoiceRepository(f.session, placement);
  const principal = { kind: "user", id: actorUserId };
  try {
    await seedMessageSpace(f.client, { space, channel: channelId, at: new Date().toISOString(), tables: [] });
    await f.run(`INSERT INTO control.channel_space_directory
      (channel_id,space_id,updated_at) VALUES ($1,$2,now())`, [channelId, space]);
    await f.run(`INSERT INTO data.space_members
      (space_id,user_id,role,version,email,display_name,created_at,updated_at)
      VALUES ($1,$2,'owner',1,'owner@example.test','Owner',now(),now())`, [space, actorUserId]);
    await append(env, channelId, { commandId: "first", messageId: first, channelId, principal, body: "Fix the build" });
    await choices.open({ requestId: "open", channelId, messageId: first, authorUserId: actorUserId });
    await f.run(`UPDATE data.first_message_launch_choices SET deadline_at=clock_timestamp()-interval '1 second'
      WHERE channel_id=$1`, [channelId]);
    await choices.claim({ requestId: "choose", channelId, messageId: first, by: "jev", actorUserId, harness: "codex" });
    let loseAcknowledgement = true;
    const ports = {
      append: async (...args) => Response.json(await append(...args)),
      postCommit: input => dispatchProductMessageLaunches(input, {
        registration: async () => ({ selectionCount: 1, prepared: [], rejected: [{ code: "registration_quota_exhausted" }] }),
      }, async notice => {
        await dispatchProductAgentSystemNotice({ ...notice, append });
        if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error("lost receipt acknowledgement"); }
      }),
      summoned: (_env, where) => choices.summoned({ requestId: "summoned", ...where }),
    };
    const input = { env, channelId, messageId: first, actorUserId, harness: "codex" };
    await assert.rejects(summonFirstMessageHarness(input, ports));
    assert.equal((await f.run("SELECT summoned_at FROM data.first_message_launch_choices"))[0].summoned_at, null);
    await summonFirstMessageHarness(input, ports);
    await summonFirstMessageHarness(input, ports);
    assert.ok((await f.run("SELECT summoned_at FROM data.first_message_launch_choices"))[0].summoned_at);
    const history = await postgresMessageHistory(env, { channelId, principal, limit: 20 }, dependencies);
    assert.equal(history.messages.length, 3, "first message, system summon and exactly one refusal receipt");
    const notice = history.messages.find(message => message.body.startsWith("Agent launch failed:"));
    assert.ok(notice);
    assert.match(notice.body, /registration_quota_exhausted/);
    assert.equal(notice.messageResidual.appMetadata.sourceMessageId, "xmatrix-summon:first");
    assert.equal(notice.messageResidual.replyToMessageId, undefined);
    // Human summons retain their reply semantics through the same authority.
    await dispatchProductMessageLaunches({ ...input, messageId: first, body: "@codex task", senderKind: "user", senderId: actorUserId },
      { registration: async () => ({ selectionCount: 1, prepared: [], rejected: [{ code: "registration_daemon_offline" }] }) },
      notice => dispatchProductAgentSystemNotice({ ...notice, append }));
    const after = await postgresMessageHistory(env, { channelId, principal, limit: 20 }, dependencies);
    assert.equal(after.messages.find(message => message.body.includes("registration_daemon_offline")).messageResidual.replyToMessageId, first);
  } finally { await f.close(); }
});
