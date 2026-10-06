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
      body: JSON.stringify({ body: message }),
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
