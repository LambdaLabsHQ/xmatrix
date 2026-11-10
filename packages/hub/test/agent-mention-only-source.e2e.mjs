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

// Protect the public send contract: an unaddressed Agent must fail before
// publication, rather than return success for a message nobody can route.
test("a send without an Instance refuses summons until launch is explicitly requested", async () => {
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
    const url = `/api/channels/${encodeURIComponent(scenario.channelId)}/messages`;
    const post = payload => worker.fetch(url, { method: "POST",
      headers: { ...scenario.auth, "content-type": "application/json" }, body: JSON.stringify(payload) });
    const clientMessageId = randomUUID();
    const mention = `@auto harness:codex pwd:"${scenario.canonicalCwd}"`;
    const message = `${mention} review the draft`;
    for (const body of [message, "@codex review the draft", "@codex launch:force review the draft",
      "@codex:1 please ask @claude to review", "@repo:LambdaLabsHQ/xmatrix review"]) {
      const refused = await post({ body, clientMessageId });
      assert.equal(refused.status, 400, await refused.clone().text());
      const result = await refused.json();
      assert.equal(result.code, "agent_instance_required");
      assert.match(result.error, /Instance/);
      assert.match(result.error, /--launch/);
    }
    assert.equal((await post({ body: message, launch: false })).status, 400);
    const history = await json(await worker.fetch(
      `/api/channels/${encodeURIComponent(scenario.channelId)}/history?limit=20`, { headers: scenario.auth }));
    assert.ok(!history.messages.some(entry => entry.messageId === clientMessageId), "refusal publishes nothing");
    await assert.rejects(daemon.inbox.waitFor(command => command.type === "machine_spawn_agent", "a spawn", 500),
      /waiting for a spawn/);
    // Instance addresses, Human mentions, and quoted examples need no launch request.
    for (const body of ["@codex:1 review the draft", "@Daniel review the draft", "Example: `@codex review`",
      "> @codex review", "```text\n@auto review\n```", "@codex:1:stop done"]) {
      const response = await post({ body });
      assert.equal(response.status, 200, await response.clone().text());
    }
    // The refused id is reusable: there was no successful send to recover.
    const spawn = daemon.inbox.waitFor(command => command.type === "machine_spawn_agent" &&
      command.channelId === scenario.channelId, "explicit launch");
    const launched = await post({ body: message, clientMessageId, launch: true });
    assert.equal(launched.status, 200, await launched.clone().text());
    assert.equal((await launched.json()).message.messageId, clientMessageId);
    assert.equal((await spawn).sourceMessageId, clientMessageId);
  } finally {
    daemon?.ws.close();
    await worker.stop();
  }
});
