import { stopAgentWorker } from "./support/agent-worker.mjs";
import { startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";
import {
  assert,
  connectAgent,
  json,
  MOCK_TOKEN,
  randomUUID,
  runAgentConnection,
  test,
  waitForChannelHistoryMessage,
} from "./agent-mention-spawn.fixture.mjs";
import { createPgSpawnableScenario, launchScenarioRun, sendSpawnResult, sendStopResult }
  from "./agent-launch-postgres.fixture.mjs";

test("a Workstation startup failure is persisted in-channel as a product notice", async () => {
  const userId = `agent-start-failure-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "agent-start-failure@example.com", name: "Agent Start Failure" });
  let daemon;
  let agent;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-start-failure" });
    ({ daemon } = scenario);
    const { auth, channelId } = scenario;

    const { command, token: runToken } = await launchScenarioRun(worker, scenario, "reproduce startup failure");
    sendSpawnResult(daemon, command, { ok: true, pid: 4242 });
    agent = await connectAgent(worker, runAgentConnection(command, channelId), runToken);
    const instanceId = agent.agent.instanceId || agent.agent.id;
    const liveBeforeFailure = await json(await worker.fetch("/api/agent-instances", {
      headers: auth,
    }));
    assert.ok(liveBeforeFailure.instances.some((instance) => instance.instanceId === instanceId));
    const runtimeError =
      "Codex error: This request was blocked by our safety systems. Reason: Potentially unintended activity.";
    const shutdown = agent.inbox.waitFor(
      (message) => message.type === "shutdown_requested",
      "Runtime startup failure purge",
    );
    const exitReport = {
      type: "machine_run_exited",
      requestId: `failure-exit:${command.runId}`,
      runId: command.runId,
      executionKey: command.executionKey,
      agentId: command.identityId,
      agentName: command.agentName,
      pid: 4242,
      status: "exit code: 1",
      exitCode: 1,
      statusPhase: "wrapper_startup_failed",
      runStatusDetail: runtimeError,
      completed: true,
      delivered: false,
    };
    daemon.ws.send(JSON.stringify(exitReport));
    await shutdown;
    await daemon.inbox.waitFor(message => message.type === "machine_run_report_acked" &&
      message.requestId === exitReport.requestId, "first failure report committed");
    daemon.ws.send(JSON.stringify(exitReport));
    await daemon.inbox.waitFor(message => message.type === "machine_run_report_acked" &&
      message.requestId === exitReport.requestId, "replayed failure report committed");

    const notice = await waitForChannelHistoryMessage(
      worker,
      MOCK_TOKEN,
      channelId,
      (message) =>
        message.metadata?.source === "machine_run_failure" &&
        message.metadata?.runId === command.runId,
      "persisted Agent startup failure notice",
    );
    assert.match(notice.body, /Couldn't start @codex-start-failure/u);
    assert.match(notice.body, /wrapper_startup_failed/u);
    // Preserve the adapter's vendor attribution with the original error text.
    assert.ok(notice.body.includes(runtimeError));
    assert.doesNotMatch(notice.body, /Runtime error:/u);
    assert.equal(notice.from.label, "xMatrix");
    assert.equal(notice.metadata?.xmatrixProvenance, "system_fact");
    assert.equal(notice.metadata?.xmatrixSystemNotice, true);
    assert.equal(notice.metadata?.source, "machine_run_failure");
    assert.equal(notice.metadata?.runId, command.runId);
    assert.equal(notice.metadata?.failureDetail, runtimeError);
    const history = await json(await worker.fetch(`/api/channels/${channelId}/history?limit=20`, { headers: auth }));
    assert.equal(history.messages.filter(message => message.metadata?.source === "machine_run_failure" &&
      message.metadata?.runId === command.runId).length, 1, "replayed terminal reports must not duplicate the notice");
    const liveAfterFailure = await json(await worker.fetch("/api/agent-instances", {
      headers: auth,
    }));
    assert.equal(liveAfterFailure.instances.some((instance) => instance.instanceId === instanceId), false,
      "wrapper startup failure must not leave a ghost online Instance");
  } finally {
    await stopAgentWorker(worker, agent, daemon);
  }
});

test("pre-spawn repository failure reaches Channel history and invocation details despite the earlier Launch failure", async () => {
  const worker = await startMockUserHubWorker({ id: `pre-spawn-failure-${randomUUID()}`,
    email: "pre-spawn-failure@example.com", name: "Pre-spawn Failure" });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-repo-failure" });
    ({ daemon } = scenario);
    const { auth, channelId } = scenario;
    const { command } = await launchScenarioRun(worker, scenario, "reproduce repository preparation failure");
    const failure = { ok: false, error: "repo pool lease unavailable (base_ref_unresolved: could not resolve origin default branch after fetch) /private/TOKEN_SENTINEL" };
    sendSpawnResult(daemon, command, failure);
    const notice = await waitForChannelHistoryMessage(worker, MOCK_TOKEN, channelId,
      message => message.metadata?.source === "machine_run_failure" && message.metadata?.runId === command.runId,
      "pre-spawn failure notice");
    assert.match(notice.body, /no usable default branch/u);
    assert.match(notice.body, /initial commit/u);
    assert.equal(notice.metadata.failureCode, "repository_base_unresolved");
    assert.doesNotMatch(JSON.stringify(notice), /TOKEN_SENTINEL/u);
    const headers = { ...auth, "content-type": "application/json" };
    const diagnosis = await json(await worker.fetch("/api/invocations/diagnostics", {
      method: "POST", headers, body: JSON.stringify({ runId: command.runId }),
    }));
    const launch = diagnosis.launches.find(value => value.runId === command.runId);
    assert.equal(launch.state, "failed");
    assert.equal(launch.errorCode, "repository_base_unresolved");
    assert.equal(launch.spawnedAt, undefined);
    const page = await json(await worker.fetch(`/api/channels/${channelId}/agent-launches/query`, {
      method: "POST", headers, body: JSON.stringify({ sourceMessageIds: [launch.sourceMessageId] }),
    }));
    assert.match(page.launches[0].errorMessage, /no usable default branch/u);
    assert.doesNotMatch(JSON.stringify(page), /TOKEN_SENTINEL/u);
    sendSpawnResult(daemon, command, failure);
    // A following stop on the same ordered socket proves the replay has been
    // processed before counting persisted failure notices.
    const stop = daemon.inbox.waitFor(message => message.type === "machine_stop_agent" && message.runId === command.runId,
      "failed startup cleanup");
    const stopCommand = await stop;
    sendStopResult(daemon, stopCommand, { ok: true });
    const cleanup = await waitForChannelHistoryMessage(worker, MOCK_TOKEN, channelId,
      message => message.metadata?.source === "machine_stop_result" && message.metadata?.runId === command.runId,
      "failed startup cleanup notice");
    assert.match(cleanup.body, /^Startup failed/u);
    assert.match(cleanup.body, /no process remains/u);
    const history = await json(await worker.fetch(`/api/channels/${channelId}/history?limit=20`, { headers: auth }));
    assert.equal(history.messages.filter(message => message.metadata?.source === "machine_run_failure" &&
      message.metadata?.runId === command.runId).length, 1, "replay does not duplicate the failure notice");
  } finally {
    await stopAgentWorker(worker, undefined, daemon);
  }
});
