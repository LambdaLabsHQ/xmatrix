import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "libpg-query";
import { resolveMessageAgentTargets } from "../dist/message-agent-targets.js";

test("an existing-instance address resolves a registered Instance, whose actor is the Instance", async () => {
  const calls = [];
  const tx = { query: async query => {
    calls.push(query);
    return [{ address: "@eevee:2", instance_id: "instance-2", run_id: "run-2" }];
  } };
  const [target] = await resolveMessageAgentTargets(tx, { spaceId: "space", channelId: "channel",
    messageId: "message", body: "@eevee:2 please continue" });
  assert.equal(target.resolution, "resolved");
  assert.equal(target.instanceId, "instance-2");
  assert.equal("agentProfileId" in target, false);
  const sql = calls[0].text;
  await assert.doesNotReject(() => parse(sql));
  assert.doesNotMatch(sql, /agent_profile/u);
  assert.match(sql, /JOIN data\.run_agent_registrations binding/u);
  assert.match(sql, /lower\(registration\.display_name\)=lower\(request\.name\)/u);
});
