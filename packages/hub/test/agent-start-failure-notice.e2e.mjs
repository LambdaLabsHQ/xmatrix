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

/** The Hub's note about one Run on the summon that started it, once it lands. */
async function runNote(worker, auth, channelId, runId, label) {
  const headers = { ...auth, "content-type": "application/json" };
  const sourceMessageId = (await diagnosedLaunch(worker, headers, runId)).sourceMessageId;
  const message = await waitForChannelHistoryMessage(worker, MOCK_TOKEN, channelId,
    (candidate) => candidate.messageId === sourceMessageId &&
      (candidate.commandResult?.notes ?? []).some((note) => note.runId === runId), label);
  return { message, notes: message.commandResult.notes.filter((note) => note.runId === runId) };
}

async function diagnosedLaunch(worker, headers, runId) {
  const diagnosis = await json(await worker.fetch("/api/invocations/diagnostics", {
    method: "POST", headers, body: JSON.stringify({ runId }),
  }));
  return diagnosis.launches.find(value => value.runId === runId);
}

test("authenticated checkout evidence reaches invocation details and continuity notices deduplicate", async () => {
  const worker = await startMockUserHubWorker({ id: `baseline-${randomUUID()}`,
    email: "baseline@example.com", name: "Baseline" });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-baseline" });
    ({ daemon } = scenario);
    const { auth, channelId } = scenario;
    const { command } = await launchScenarioRun(worker, scenario, "inspect checkout continuity");
    const baseline = { baseRef: "origin/main", baseOid: "a".repeat(40), confirmedAt: "2026-10-08T10:00:00Z",
      remote: { baseRef: "origin/trunk", baseOid: "b".repeat(40), confirmedAt: "2026-10-08T10:01:00Z" },
      relationship: "diverged", noticeKey: "c".repeat(64) };
    const result = { ok: true, pid: 4242, metadata: { repositoryBaseline: { ...baseline, privatePath: "/PRIVATE" } } };
    sendSpawnResult(daemon, command, result);
    const notice = await waitForChannelHistoryMessage(worker, MOCK_TOKEN, channelId,
      message => message.metadata?.source === "repository_baseline", "continuity notice");
    sendSpawnResult(daemon, command, result);
    const headers = { ...auth, "content-type": "application/json" };
    const source = (await diagnosedLaunch(worker, headers, command.runId)).sourceMessageId;
    const query = await json(await worker.fetch(`/api/channels/${channelId}/agent-launches/query`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ sourceMessageIds: [source] }),
    }));
    const launch = query.launches.find(value => value.runId === command.runId);
    assert.equal(launch.activity.repositoryBaseline.baseOid, baseline.baseOid);
    assert.equal(launch.activity.repositoryBaseline.confirmedAt, "2026-10-08T10:00:00.000Z");
    assert.equal(launch.activity.repositoryBaseline.relationship, "diverged");
    assert.doesNotMatch(JSON.stringify(query), /PRIVATE/u);
    const history = await json(await worker.fetch(`/api/channels/${channelId}/history?limit=20`, { headers: auth }));
    assert.equal(history.messages.filter(message => message.messageId === notice.messageId).length, 1);
  } finally {
    await stopAgentWorker(worker, daemon);
  }
});

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

    // A summoned Run's failed start answers on the summon, not as another message.
    const { notes } = await runNote(worker, auth, channelId, command.runId, "startup failure on its summon");
    assert.equal(notes.length, 1, "replayed terminal reports must not duplicate the note");
    const [note] = notes;
    assert.match(note.text, /Couldn't start @codex-start-failure/u);
    assert.match(note.text, /wrapper_startup_failed/u);
    // Preserve the adapter's vendor attribution with the original error text.
    assert.ok(note.text.includes(runtimeError));
    assert.doesNotMatch(note.text, /Runtime error:/u);
    const history = await json(await worker.fetch(`/api/channels/${channelId}/history?limit=20`, { headers: auth }));
    assert.equal(history.messages.filter(message => message.metadata?.source === "machine_run_failure").length, 0,
      "the failure is not posted as another message");
    const liveAfterFailure = await json(await worker.fetch("/api/agent-instances", {
      headers: auth,
    }));
    assert.equal(liveAfterFailure.instances.some((instance) => instance.instanceId === instanceId), false,
      "wrapper startup failure must not leave a ghost online Instance");
  } finally {
    await stopAgentWorker(worker, agent, daemon);
  }
});

for (const [reason, code] of [
  ["base_ref_unresolved: could not resolve origin default branch after fetch", "repository_base_unresolved"],
  ["fetch_required_failed: required origin fetch failed (\n ! [rejected] main -> origin/main (non-fast-forward))", "repository_fetch_failed"],
]) test(`pre-spawn ${code} preserves its cause in Channel history and invocation details`, async () => {
  const worker = await startMockUserHubWorker({ id: `pre-spawn-failure-${randomUUID()}`,
    email: "pre-spawn-failure@example.com", name: "Pre-spawn Failure" });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-repo-failure" });
    ({ daemon } = scenario);
    const { auth, channelId } = scenario;
    const { command } = await launchScenarioRun(worker, scenario, "reproduce repository preparation failure");
    const failure = { ok: false, error: `repo pool lease unavailable (${reason}) /private/TOKEN_SENTINEL` };
    sendSpawnResult(daemon, command, failure);
    const { notes: [note] } = await runNote(worker, auth, channelId, command.runId, "pre-spawn failure on its summon");
    assert.ok(note.text.includes(reason));
    assert.doesNotMatch(note.text, /initial commit|Check the machine/u);
    assert.doesNotMatch(JSON.stringify(note), /TOKEN_SENTINEL/u);
    const headers = { ...auth, "content-type": "application/json" };
    const launch = await diagnosedLaunch(worker, headers, command.runId);
    assert.equal(launch.state, "failed");
    assert.equal(launch.errorCode, code);
    assert.equal(launch.spawnedAt, undefined);
    const page = await json(await worker.fetch(`/api/channels/${channelId}/agent-launches/query`, {
      method: "POST", headers, body: JSON.stringify({ sourceMessageIds: [launch.sourceMessageId] }),
    }));
    assert.ok(page.launches[0].errorMessage.includes(reason));
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
    const { notes: replayed } = await runNote(worker, auth, channelId, command.runId, "pre-spawn failure after replay");
    assert.equal(replayed.filter(item => item.id.includes(":startup-failure:")).length, 1,
      "replay does not duplicate the failure note");
  } finally {
    await stopAgentWorker(worker, undefined, daemon);
  }
});
