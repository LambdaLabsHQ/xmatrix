import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "libpg-query";
import { resolveMessageAgentTargets } from "../dist/message-agent-targets.js";

const row = (ordinal, displayName, harness = displayName.toLowerCase()) => ({ ordinal: String(ordinal),
  instance_id: `channel:${ordinal}`, run_id: `channel:${ordinal}#1`, display_name: displayName, harness });

test("an existing-instance address resolves a registered Instance, whose actor is the Instance", async () => {
  const calls = [];
  const tx = { query: async query => {
    calls.push(query);
    return [row(2, "Eevee")];
  } };
  const [target] = await resolveMessageAgentTargets(tx, { spaceId: "space", channelId: "channel",
    messageId: "message", body: "@eevee:2 please continue" });
  assert.equal(target.resolution, "resolved");
  assert.equal(target.instanceId, "channel:2");
  assert.equal("agentProfileId" in target, false);
  const sql = calls[0].text;
  await assert.doesNotReject(() => parse(sql));
  assert.doesNotMatch(sql, /agent_profile/u);
  assert.match(sql, /JOIN data\.run_agent_registrations binding/u);
  assert.deepEqual(calls[0].values[2], ["2"], "only the addressed ordinals are read");
});

// Channel 5017cc66: antigravity:1 and antigravity:2 were both live, and an
// exact `@antigravity:2` must name the second one, never neither.
test("an exact name:N resolves by the shared addressing rule when another Instance shares the name", async () => {
  const tx = { query: async () => [row(1, "antigravity"), row(2, "antigravity"), row(3, "Gemini", "antigravity")] };
  const resolve = async body => (await resolveMessageAgentTargets(tx, { spaceId: "space", channelId: "channel",
    messageId: "message", body })).map(target => [target.sourceMention, target.instanceId ?? target.resolution]);
  assert.deepEqual(await resolve("@antigravity:2 请刷新预览码"), [["@antigravity:2", "channel:2"]]);
  assert.deepEqual(await resolve("＠Antigravity:1 看一下"), [["＠Antigravity:1", "channel:1"]]);
  assert.deepEqual(await resolve("@gemini:3 and @antigravity:3"),
    [["@gemini:3", "channel:3"], ["@antigravity:3", "channel:3"]], "display name and harness both hit");
  assert.deepEqual(await resolve("@claude:2 not this one"), [["@claude:2", "unavailable"]]);
});
