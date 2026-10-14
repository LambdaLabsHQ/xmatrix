import { assert, connectAgent, MOCK_TOKEN, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";
import { createPgSpawnableScenario, inTestTransaction, launchScenarioRun, startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";

const errorMessage = "Selected model is at capacity. Please try a different model.";
async function retryState(runId) {
  return (await inTestTransaction(tx => tx.query({ text: "SELECT capacity_retry_json AS retry FROM data.runs WHERE run_id=$1",
    values: [runId] })))[0].retry;
}
async function eventually(testState) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (await testState()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Hub retry state did not converge");
}

// This is the owning PostgreSQL + authenticated socket + real Channel alarm
// boundary. It catches lost durable work, budget resets and grant bypasses that
// a pure policy test or provider fixture cannot observe.
test("Hub persists the retry budget across replay/reconnect, exposes it, and fences cancellation/revocation", { timeout: 240_000 }, async () => {
  const worker = await startMockUserHubWorker({ id: `retry-${randomUUID()}`, email: "retry@example.com", name: "Retry" });
  let scenario;
  const sockets = [];
  try {
    scenario = await createPgSpawnableScenario(worker, { agentName: "codex-retry" });
    const { command, token, body } = await launchScenarioRun(worker, scenario);
    const connect = async () => {
      const socket = await connectAgent(worker, { ...body, capabilities: ["agent_turn_retry", "agent_turn_retry_channel_message"] }, token);
      sockets.push(socket);
      const joined = await socket.request({ type: "join_channel", channelId: scenario.channelId, historyLimit: 0 });
      assert.equal(joined.type, "channel_joined");
      return socket;
    };
    let agent = await connect();
    const operationId = randomUUID();
    let attemptToken;
    let first;
    const retryMessages = [];
    for (let index = 0; index < 3; index++) {
      const report = { type: "agent_turn_retry", requestId: randomUUID(), operationId, action: "failed",
        threadId: "provider-thread", turnId: `provider-turn-${index}`, safeToContinue: true, errorMessage,
        ...(attemptToken ? { attemptToken } : {}) };
      first ??= report;
      agent.ws.send(JSON.stringify(report));
      if (index === 0) {
        await eventually(async () => (await retryState(command.runId))?.state === "waiting");
        agent.ws.send(JSON.stringify(report));
        agent.ws.close();
        agent = await connect();
        agent.ws.send(JSON.stringify(report));
      }
      const delivered = await agent.inbox.waitFor(message =>
        ["channel_message_received", "channel_history_replay"].includes(message.type) &&
        message.message.metadata?.xmatrixTurnRetry?.requestId === report.requestId,
        "committed Channel retry instruction", 60_000);
      const message = delivered.message;
      const receipt = message.metadata.xmatrixTurnRetry;
      assert.equal(receipt.state, "issued");
      assert.equal(receipt.operationId, operationId);
      assert.equal(receipt.runId, command.runId);
      assert.match(message.body, /Continue the previous request/u);
      assert.match(message.body, new RegExp(`retry ${index + 1}/3`));
      assert.ok(message.sequence > 0);
      assert.equal(delivered.deliveryIntent, "context"); // peers and stale waits never execute it
      retryMessages.push(message);
      attemptToken = receipt.attemptToken;
      // A replay republishes the same committed instruction, not a private permit.
      if (index === 0) {
        agent.ws.send(JSON.stringify(report));
        const repeated = await agent.inbox.waitFor(frame =>
          frame.type === "channel_message_received" && frame.message.messageId === message.messageId,
          "same committed retry message", 20_000);
        assert.equal(repeated.message.sequence, message.sequence);
        assert.equal(repeated.message.body, message.body);
      }
      assert.equal((await retryState(command.runId)).attempt, index + 1);
    }
    const last = { type: "agent_turn_retry", requestId: randomUUID(), operationId, action: "failed",
      threadId: "provider-thread", turnId: "last-turn", safeToContinue: true, errorMessage, attemptToken };
    agent.ws.send(JSON.stringify(last));
    const exhausted = await agent.inbox.waitFor(m => m.type === "agent_turn_retry_decision" && m.requestId === last.requestId, "exhausted retry");
    assert.equal(exhausted.action, "stop");
    assert.equal(exhausted.reason, "exhausted");
    assert.equal((await retryState(command.runId)).attempt, 3);
    await eventually(async () => !(await retryState(command.runId)).notice);
    const historyResponse = await worker.fetch(`/api/channels/${scenario.channelId}/history?limit=30`, { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } });
    const history = await historyResponse.json();
    const messages = history.messages ?? history.data?.messages ?? [];
    for (let attempt = 1; attempt <= 3; attempt++)
      assert.ok(messages.some(m => m.body?.includes(`retry ${attempt}/3`)), `visible retry ${attempt}`);
    assert.ok(messages.some(m => m.body?.includes("Hub stopped retrying") && m.body.includes(`Error: ${errorMessage}`)));
    for (const delivered of retryMessages) {
      const stored = messages.find(message => message.messageId === delivered.messageId);
      assert.ok(stored, "the retry instruction must exist in authoritative Channel history");
      assert.equal(stored.body, delivered.body);
      assert.equal(stored.sequence, delivered.sequence);
      assert.deepEqual(stored.metadata.xmatrixTurnRetry, delivered.metadata.xmatrixTurnRetry);
      assert.equal(stored.metadata.xmatrixTurnRetry.threadId, undefined);
      assert.equal(stored.metadata.xmatrixTurnRetry.turnId, undefined);
    }
    assert.equal(messages.filter(message => message.metadata?.xmatrixTurnRetry?.state === "issued").length, 3);

    // A stop arriving before a delayed failure is still an authoritative fence.
    const earlyId = randomUUID();
    const earlyStop = { type: "agent_turn_retry", requestId: randomUUID(), operationId: earlyId, action: "cancelled" };
    agent.ws.send(JSON.stringify(earlyStop));
    await agent.inbox.waitFor(m => m.type === "agent_turn_retry_decision" && m.requestId === earlyStop.requestId, "early stop receipt");
    const lateFailure = { ...first, requestId: randomUUID(), operationId: earlyId, turnId: "late-after-stop" };
    agent.ws.send(JSON.stringify(lateFailure));
    await agent.inbox.waitFor(m => m.type === "error" && m.requestId === lateFailure.requestId, "late failure fenced");
    assert.equal((await retryState(command.runId)).state, "exhausted");

    const next = { ...first, requestId: randomUUID(), operationId: randomUUID(), turnId: "next-task" };
    agent.ws.send(JSON.stringify(next));
    await eventually(async () => (await retryState(command.runId))?.operationId === next.operationId);
    // An older operation cannot reopen even after another task replaced it.
    const stale = { ...first, requestId: randomUUID() };
    agent.ws.send(JSON.stringify(stale));
    await agent.inbox.waitFor(m => m.type === "error" && m.requestId === stale.requestId, "retired operation rejected");
    assert.equal((await retryState(command.runId)).operationId, next.operationId);
    const cancel = { type: "agent_turn_retry", requestId: randomUUID(), operationId: next.operationId, action: "cancelled" };
    agent.ws.send(JSON.stringify(cancel));
    await agent.inbox.waitFor(m => m.type === "agent_turn_retry_decision" && m.requestId === cancel.requestId, "cancel receipt");
    assert.equal((await retryState(command.runId)).state, "cancelled");

    const revoked = { ...first, requestId: randomUUID(), operationId: randomUUID(), turnId: "revoked-task" };
    agent.ws.send(JSON.stringify(revoked));
    await eventually(async () => (await retryState(command.runId))?.operationId === revoked.operationId);
    await inTestTransaction(tx => tx.query({ text: `UPDATE data.space_agent_registration_access
      SET grant_state='revoked',grant_revision=grant_revision+1,grant_execution_revision=grant_execution_revision+1 WHERE machine_id=$1`, values: [scenario.machineId] }));
    await eventually(async () => (await retryState(command.runId))?.state === "cancelled");
    assert.notEqual((await retryState(command.runId)).state, "issued");
  } finally {
    for (const socket of sockets) socket.ws.close();
    scenario?.daemon.ws.close();
    await worker.stop();
  }
});

test("Hub reports an error it does not retry as the turn failure, with the original error, once", { timeout: 120_000 }, async () => {
  const worker = await startMockUserHubWorker({ id: `retry-${randomUUID()}`, email: "retry@example.com", name: "Retry" });
  let scenario;
  let agent;
  try {
    scenario = await createPgSpawnableScenario(worker, { agentName: "codex-failure" });
    const { token, body } = await launchScenarioRun(worker, scenario);
    agent = await connectAgent(worker, { ...body, capabilities: ["agent_turn_retry", "agent_turn_retry_channel_message"] }, token);
    const original = "Internal error: unknown certificate verification error (provider request 7f3a)";
    const report = { type: "agent_turn_retry", requestId: randomUUID(), operationId: randomUUID(), action: "failed",
      threadId: "provider-thread", turnId: "provider-turn", safeToContinue: true, errorMessage: original };
    for (const requestId of [report.requestId, randomUUID()]) {
      agent.ws.send(JSON.stringify({ ...report, requestId }));
      const decision = await agent.inbox.waitFor(m => m.type === "agent_turn_retry_decision" && m.requestId === requestId, "stop decision");
      assert.equal(decision.action, "stop");
      assert.equal(decision.reason, "ineligible", "the host stays silent: Hub reports this failure");
    }
    const history = await (await worker.fetch(`/api/channels/${scenario.channelId}/history?limit=30`,
      { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } })).json();
    const messages = history.messages ?? history.data?.messages ?? [];
    const failures = messages.filter(m => m.body?.includes(original));
    assert.equal(failures.length, 1, "one notice, carrying the original error, survives a replayed report");
    assert.match(failures[0].body, /^xMatrix could not complete this codex-failure turn: /u);
    assert.ok(!messages.some(m => m.body?.includes("Agent trace")));
  } finally {
    agent?.ws.close();
    scenario?.daemon.ws.close();
    await worker.stop();
  }
});
