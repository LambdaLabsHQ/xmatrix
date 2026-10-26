import { createPgSpawnableScenario, isSpawnOf, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import { assert, channelHistory, mintAgentRunToken, MOCK_TOKEN, postChannelMessage, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";

const run = async (worker, token, argv) => {
  const response = await worker.fetch("/api/cli/commands/run", { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ argv }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};

test("Hub commands answer a person and a Run through the Hub's own routes", async () => {
  const worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
    XMATRIX_MOCK_AUTH_USER_ID: `cli-commands-${randomUUID()}`, XMATRIX_MOCK_AUTH_EMAIL: "cli-commands@example.com",
    XMATRIX_MOCK_AUTH_NAME: "CLI Commands" } });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-cli-commands" });
    ({ daemon } = scenario);
    const { channelId, registration, machineId, canonicalCwd } = scenario;

    assert.deepEqual(await run(worker, MOCK_TOKEN, ["logn"]), { unknownCommand: true });
    const listing = await run(worker, MOCK_TOKEN, ["commands"]);
    assert.equal(listing.exitCode, 0);
    assert.match(listing.stdout, /automation pause\s+Pause an Automation/);
    assert.match(listing.stdout, /call\s+Call a connected app read action with public or private results/);
    const privateHelp = await run(worker, MOCK_TOKEN, ["call", "--help"]);
    assert.match(privateHelp.stdout, /only this caller receives/);
    const humanCall = await run(worker, MOCK_TOKEN, ["call", "@gmail:read:18f2a9c0d1e2b3a4", "--private"]);
    assert.equal(humanCall.exitCode, 1);
    assert.match(humanCall.stderr, /require an Agent Run/);
    const list = await run(worker, MOCK_TOKEN, ["automation", "list", "--channel", channelId]);
    assert.deepEqual(list, { stdout: "", exitCode: 0 });

    await postChannelMessage(worker, MOCK_TOKEN, channelId,
      `@auto harness:codex machine:${machineId} pwd:"${canonicalCwd}" list automations`);
    const spawn = await daemon.inbox.waitFor((message) => message.type === "machine_spawn_agent" &&
      message.channelId === channelId && isSpawnOf(message, registration), "machine spawn");
    const runToken = await mintAgentRunToken(worker, daemon, spawn, channelId);
    const asRun = await run(worker, runToken, ["automation", "list", "--channel", channelId, "--json"]);
    assert.equal(asRun.exitCode, 0, asRun.stderr);
    assert.deepEqual(JSON.parse(asRun.stdout), []);
    const privateRead = await run(worker, runToken, ["call", "@gmail:read:18f2a9c0d1e2b3a4", "--private"]);
    assert.equal(privateRead.exitCode, 1);
    assert.match(privateRead.stderr, /connect Gmail/);
    const history = await channelHistory(worker, MOCK_TOKEN, channelId);
    const invocation = history.messages.find(message => message.body === "@gmail:read:18f2a9c0d1e2b3a4");
    assert.ok(invocation, "the authenticated Run's call is a normal persisted Channel invocation");
    assert.equal(invocation.from.kind, "agent");
    const receipt = history.messages.find(message => message.replyToMessageId === invocation.messageId);
    assert.ok(receipt, "a denied private call still has a threaded result receipt");
    assert.match(receipt.body, /Gmail read: blocked; Result: \[hidden — private call\]/);
    assert.doesNotMatch(receipt.body, /connect Gmail/);
    const refused = await run(worker, runToken, ["automation", "pause", "missing", "--version", "1"]);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, /^error: .*\(HTTP 4\d\d\)\n$/);
  } finally {
    daemon?.ws.close();
    await worker.stop();
  }
});
