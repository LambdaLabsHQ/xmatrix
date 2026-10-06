import assert from "node:assert/strict";
import test from "node:test";
import { resolveMessageAgentTargets } from "../dist/message-agent-targets.js";

const input = { spaceId: "space", channelId: "channel", messageId: "message" };
test("target snapshots preserve complete literal addresses and exclude Markdown examples", async () => {
  const tx = { query: async () => [] };
  const targets = await resolveMessageAgentTargets(tx, { ...input,
    body: "@Alpha:1 go; ＠Alpha:1 twice\n`@Alpha:2`\n\n> @Alpha:3\n\n@Alpha:1:reborn restart" });
  assert.deepEqual(targets.map(target => target.sourceMention), ["@Alpha:1", "＠Alpha:1"]);
  assert.ok(targets.every(target => target.resolution === "unavailable" && !target.runId));
});

test("target resolution bounds both count and stored bytes without truncating identity", async () => {
  let queries = 0;
  const tx = { query: async query => {
    queries += 1;
    return JSON.parse(query.values[2]).map(request => ({ address: request.address,
      instance_id: "i".repeat(450), run_id: "r".repeat(450) }));
  } };
  const body = Array.from({ length: 1001 }, (_, index) => `@Alpha:${index + 1}`).join(" ");
  assert.equal(await resolveMessageAgentTargets(tx, { ...input, body }), undefined);
  assert.equal(queries, 0);
  assert.equal(await resolveMessageAgentTargets(tx, { ...input, body: body.slice(0, body.lastIndexOf(" ")) }), undefined);
  assert.equal(queries, 1);
});
