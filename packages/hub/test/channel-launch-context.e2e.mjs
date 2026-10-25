import { createPgSpawnableScenario, homeSpaceId, isSpawnOf, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import {
  assert,
  json,
  mintAgentRunToken,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  test,
} from "./agent-mention-spawn.fixture.mjs";

test("a launch reads the conversation as one Hub-rendered transcript, without the message it was started for", async () => {
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: `launch-context-${randomUUID()}`,
      XMATRIX_MOCK_AUTH_EMAIL: "launch-context@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Launch Context",
    },
  });
  try {
    const channel = (await json(await worker.fetch("/api/channels", {
      method: "POST",
      headers: { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ spaceId: await homeSpaceId(worker), mode: "closed", name: `launch-${randomUUID()}`, access: [] }),
    }))).channel;
    const first = (await postChannelMessage(worker, MOCK_TOKEN, channel.id, "the plan is in PR 7")).message;
    const task = (await postChannelMessage(worker, MOCK_TOKEN, channel.id, "now ship it")).message;

    const read = async (query) => {
      const response = await worker.fetch(
        `/api/channels/${encodeURIComponent(channel.id)}/launch-context${query}`,
        { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } },
      );
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const context = await read(`?startedFor=${encodeURIComponent(task.messageId)}`);
    assert.ok(context.text.startsWith(`Channel history for ${channel.id} — all 1 message(s), oldest first.`), context.text);
    assert.ok(context.text.includes(`[messageId=${first.messageId}]:\n  the plan is in PR 7\n`), context.text);
    assert.ok(!context.text.includes("now ship it"), context.text);
    assert.equal(context.startedFor.messageId, task.messageId);
    assert.equal(context.throughSequence, task.sequence);

    const whole = await read("");
    assert.ok(whole.text.includes("all 2 message(s)"), whole.text);
    assert.equal(whole.startedFor, undefined);

    const denied = await worker.fetch(`/api/channels/${encodeURIComponent(`missing-${randomUUID()}`)}/launch-context`,
      { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } });
    assert.ok(denied.status >= 400 && denied.status < 500, `unknown channel refused: ${denied.status}`);
  } finally {
    await worker.stop();
  }
});

test("the Run a summon started reads its own conversation with its Run credential", async () => {
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: `launch-context-run-${randomUUID()}`,
      XMATRIX_MOCK_AUTH_EMAIL: "launch-context-run@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Launch Context Run",
    },
  });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-launch-context" });
    ({ daemon } = scenario);
    const { channelId, registration, machineId, canonicalCwd } = scenario;
    const earlier = (await postChannelMessage(worker, MOCK_TOKEN, channelId, "context before the summon")).message;
    await postChannelMessage(worker, MOCK_TOKEN, channelId,
      `@auto harness:codex machine:${machineId} pwd:"${canonicalCwd}" read the context`);
    const spawn = await daemon.inbox.waitFor((message) => message.type === "machine_spawn_agent" &&
      message.channelId === channelId && isSpawnOf(message, registration), "machine spawn");
    const runToken = await mintAgentRunToken(worker, daemon, spawn, channelId);
    const response = await worker.fetch(`/api/channels/${encodeURIComponent(channelId)}/launch-context`,
      { headers: { Authorization: `Bearer ${runToken}` } });
    assert.equal(response.status, 200, await response.clone().text());
    const context = await response.json();
    assert.ok(context.text.includes(`[messageId=${earlier.messageId}]:\n  context before the summon\n`), context.text);
    assert.ok(context.throughSequence >= earlier.sequence);
  } finally {
    daemon?.ws.close();
    await worker.stop();
  }
});
