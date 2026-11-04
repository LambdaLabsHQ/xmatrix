import { assert, json, MOCK_TOKEN, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";
import { createPgSpawnableScenario, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

test("a Channel message with trailing whitespace launches from its exact source", async () => {
  const userId = `mention-only-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
    XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: `${userId}@example.test`,
    XMATRIX_MOCK_AUTH_NAME: "Mention Only E2E",
  } });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: `codex-only-${randomUUID()}` });
    daemon = scenario.daemon;
    const message = `@auto harness:codex pwd:"${scenario.canonicalCwd}" `;
    const spawn = daemon.inbox.waitFor(
      (command) => command.type === "machine_spawn_agent" && command.channelId === scenario.channelId,
      "mention-only exact-source spawn",
    );
    const response = await worker.fetch(`/api/channels/${encodeURIComponent(scenario.channelId)}/messages`, {
      method: "POST",
      headers: { ...scenario.auth, "content-type": "application/json" },
      body: JSON.stringify({ launch: true, body: message }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const command = await spawn;
    const history = await json(await worker.fetch(
      `/api/channels/${encodeURIComponent(scenario.channelId)}/history?limit=20`,
      { headers: scenario.auth },
    ));
    const source = history.messages.find((entry) => entry.body === message);
    assert.ok(source, "the exact mention-only message remains committed");
    assert.equal(command.sourceMessageId, source.messageId);
    assert.equal(command.workspace.canonicalCwd, scenario.canonicalCwd);
  } finally {
    daemon?.ws.close();
    await worker.stop();
  }
});

test("a summon its send did not ask to start stays a mention, and the sender is told", async () => {
  const userId = `mention-unlaunched-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
    XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: `${userId}@example.test`,
    XMATRIX_MOCK_AUTH_NAME: "Mention Unlaunched E2E",
  } });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: `codex-unlaunched-${randomUUID()}` });
    daemon = scenario.daemon;
    const mention = `@auto harness:codex pwd:"${scenario.canonicalCwd}"`;
    const message = `Done: ${mention} reviewed the draft yesterday.`;
    const sent = await json(await worker.fetch(`/api/channels/${encodeURIComponent(scenario.channelId)}/messages`, {
      method: "POST", headers: { ...scenario.auth, "content-type": "application/json" },
      body: JSON.stringify({ body: message }),
    }));
    assert.deepEqual(sent.mentionsNotLaunched, [mention]);
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      result = await json(await worker.fetch(`/api/channels/${encodeURIComponent(scenario.channelId)}/agent-launches/query`, {
        method: "POST", headers: { ...scenario.auth, "content-type": "application/json" },
        body: JSON.stringify({ sourceMessageIds: [sent.message.messageId], pageSize: 20 }) }));
      if (result.rejections?.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(result.launches, []);
    assert.deepEqual(result.rejections.map((rejection) => [rejection.code, rejection.sourceMention]),
      [["launch_not_requested", mention]]);
    await assert.rejects(daemon.inbox.waitFor((command) => command.type === "machine_spawn_agent", "a spawn", 500),
      /waiting for a spawn/);
    // The author can still start it from the mention's card.
    const started = await worker.fetch(`/api/channels/${encodeURIComponent(scenario.channelId)}/messages/${encodeURIComponent(sent.message.messageId)}/launch-anyway`, {
      method: "POST", headers: { ...scenario.auth, "content-type": "application/json" },
      body: JSON.stringify({ body: message, sourceMention: mention }) });
    assert.equal(started.status, 200, await started.clone().text());
  } finally {
    daemon?.ws.close();
    await worker.stop();
  }
});
