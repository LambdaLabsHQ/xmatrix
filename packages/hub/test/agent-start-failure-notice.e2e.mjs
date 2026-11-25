import { stopAgentWorker } from "./support/agent-worker.mjs";
import { startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";
import {
  assert,
  connectAgent,
  json,
  mintAgentRunToken,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  runAgentConnection,
  sleep,
  test,
  waitForChannelHistoryMessage,
} from "./agent-mention-spawn.fixture.mjs";
import { createPgSpawnableScenario, inTestTransaction, isSpawnOf, launchScenarioRun, postAutoLaunch, sendSpawnResult,
  sendStopResult } from "./agent-launch-postgres.fixture.mjs";

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

test("a failed wrapper startup ends automatic wakes of an established Instance", async () => {
  const worker = await startMockUserHubWorker({ id: `failed-wake-${randomUUID()}`,
    email: "failed-wake@example.com", name: "Failed Wake" });
  let daemon;
  let firstAgent;
  let wakingAgent;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-wake-failure" });
    ({ daemon } = scenario);
    const { auth, channelId } = scenario;
    const reportExit = async (command, statusPhase, runStatusDetail) => {
      const requestId = `exit:${command.runId}`;
      daemon.ws.send(JSON.stringify({ type: "machine_run_exited", requestId, runId: command.runId,
        executionKey: command.executionKey, agentId: command.identityId, agentName: command.agentName,
        pid: 4242, status: "exit code: 1", exitCode: 1,
        statusPhase, runStatusDetail }));
      await daemon.inbox.waitFor(message => message.type === "machine_run_report_acked" &&
        message.requestId === requestId, "exit report accepted");
    };

    const { command: first, token } = await launchScenarioRun(worker, scenario);
    sendSpawnResult(daemon, first, { ok: true, pid: 4242 });
    firstAgent = await connectAgent(worker, runAgentConnection(first, channelId), token);
    await reportExit(first, "turn_running");
    let rest;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const [instance] = await inTestTransaction(tx => tx.query({
        text: "SELECT rest_state FROM data.instances WHERE run_id=$1", values: [first.runId] }));
      rest = instance?.rest_state;
      if (rest === "interrupted") break;
      await sleep(100);
    }
    assert.equal(rest, "interrupted", "the first exit's lifecycle must commit before sending the waking message");
    firstAgent.ws.close();
    const isWake = message => message.type === "machine_spawn_agent" && message.identityId === first.identityId &&
      message.runId !== first.runId;
    await postChannelMessage(worker, MOCK_TOKEN, channelId, "Continue the interrupted work", { launch: false });
    const wake = await daemon.inbox.waitFor(isWake, "first automatic wake");
    const wakeToken = await mintAgentRunToken(worker, daemon, wake, channelId);
    sendSpawnResult(daemon, wake, { ok: true, pid: 4242 });
    wakingAgent = await connectAgent(worker, runAgentConnection(wake, channelId), wakeToken);
    const error = "app-server exited during initialize: Protocol input closed";
    await reportExit(wake, "wrapper_startup_failed", error);

    const notice = await waitForChannelHistoryMessage(worker, MOCK_TOKEN, channelId,
      message => message.metadata?.source === "machine_run_failure" && message.metadata.runId === wake.runId,
      "failed wake's startup notice");
    assert.ok(notice.body.includes(error));
    const { channels } = await json(await worker.fetch("/api/channels", { headers: auth }));
    const channel = channels.find(candidate => candidate.id === channelId);
    const instances = Object.values(channel.memberPresence).flatMap(member => member.instances ?? []);
    const failed = instances.find(instance => instance.id === first.identityId);
    assert.equal(failed?.rest, "wake_failed");
    assert.equal(failed.restReason, error);

    await postChannelMessage(worker, MOCK_TOKEN, channelId, "A later message", { launch: false });
    await assert.rejects(daemon.inbox.waitFor(message => isWake(message) && message.runId !== wake.runId,
      "unexpected second wake", 500), /Timed out/u);
    const history = await json(await worker.fetch(`/api/channels/${channelId}/history?limit=20`, { headers: auth }));
    assert.equal(history.messages.filter(message => message.metadata?.source === "machine_run_failure").length, 1);
  } finally {
    await stopAgentWorker(worker, firstAgent, wakingAgent, daemon);
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

/** The spawn command has gone out three times with every lease left to lapse; the Hub finds it
 * when it next hands the machine work, here a second start. */
async function leaveUnanswered(worker, scenario, command) {
  const { daemon, channelId, registration } = scenario;
  await inTestTransaction(tx => tx.query({ text: `UPDATE data.machine_daemon_commands
    SET attempts=3,lease_until=clock_timestamp()-interval '1 second' WHERE command_id=$1 RETURNING command_id`,
  values: [command.requestId] }));
  const next = daemon.inbox.waitFor(message => message.channelId === channelId && isSpawnOf(message, registration) &&
    message.runId !== command.runId, "the next start");
  await postAutoLaunch(worker, { ...scenario, harness: registration.harness }, "start again");
  await next;
}

// 2026-11-20: two daemons refused every command for six hours while connected.
// Each start was failed by the Hub after ten deliveries, with no word on its summon.
test("a start its connected machine never answers is ended after three deliveries and said on its summon", async () => {
  const worker = await startMockUserHubWorker({ id: `silent-machine-${randomUUID()}`,
    email: "silent-machine@example.com", name: "Silent Machine" });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-silent" });
    ({ daemon } = scenario);
    const { auth, channelId, registration } = scenario;
    const first = daemon.inbox.waitFor(message => message.channelId === channelId && isSpawnOf(message, registration),
      "the start, handed out once");
    await postAutoLaunch(worker, { ...scenario, harness: registration.harness }, "start on a machine that says nothing");
    // Handed to the daemon, which neither admits nor answers it.
    const command = await first;
    await leaveUnanswered(worker, scenario, command);

    const { notes } = await runNote(worker, auth, channelId, command.runId, "the silent start on its summon");
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /Couldn't start @codex-silent/u);
    assert.ok(notes[0].text.includes(
      "machine_not_answering: the machine is connected but did not answer the start command, sent to it 3 times. Nothing was started."),
    notes[0].text);
    const launch = await diagnosedLaunch(worker, { ...auth, "content-type": "application/json" }, command.runId);
    assert.equal(launch.state, "failed");
    assert.equal(launch.errorCode, "machine_not_answering");
    assert.equal(launch.spawnedAt, undefined);
    const [stored] = await inTestTransaction(tx => tx.query({
      text: "SELECT status,result_json->>'unanswered' AS unanswered FROM data.machine_daemon_commands WHERE command_id=$1",
      values: [command.requestId] }));
    assert.deepEqual(stored, { status: "failed", unanswered: "true" });
  } finally {
    await stopAgentWorker(worker, undefined, daemon);
  }
});

// The verdict is about a start nobody saw happen. A daemon that started the
// Agent and only failed to report it must not cost the Agent its Run.
test("an Agent that connected is not failed because its daemon never reported the start", async () => {
  const worker = await startMockUserHubWorker({ id: `quiet-daemon-${randomUUID()}`,
    email: "quiet-daemon@example.com", name: "Quiet Daemon" });
  let daemon;
  let agent;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-quiet" });
    ({ daemon } = scenario);
    const { auth, channelId } = scenario;
    // Admitted and started; the spawn result never comes.
    const { command, token } = await launchScenarioRun(worker, scenario, "start on a daemon that reports nothing");
    agent = await connectAgent(worker, runAgentConnection(command, channelId), token);
    const instanceId = agent.agent.instanceId || agent.agent.id;
    await leaveUnanswered(worker, scenario, command);
    // The Hub ended the command and recorded its report; the coordinator finalizes it.
    const report = () => inTestTransaction(tx => tx.query({
      text: "SELECT state FROM data.machine_run_terminal_reports WHERE run_id=$1 AND event_type='machine_spawn_result'",
      values: [command.runId] }));
    let finalized;
    for (let attempt = 0; attempt < 200 && !(finalized = (await report())[0]?.state === "finalized"); attempt += 1) await sleep(50);
    assert.equal(finalized, true, "the recorded report is finalized");

    const headers = { ...auth, "content-type": "application/json" };
    const launch = await diagnosedLaunch(worker, headers, command.runId);
    assert.equal(launch.state, "connected");
    assert.equal(launch.errorCode, undefined);
    const live = await json(await worker.fetch("/api/agent-instances", { headers: auth }));
    assert.ok(live.instances.some(instance => instance.instanceId === instanceId), "the Agent keeps its Run");
    const history = await json(await worker.fetch(`/api/channels/${channelId}/history?limit=20`, { headers: auth }));
    assert.deepEqual(history.messages.flatMap(message => message.commandResult?.notes ?? [])
      .filter(note => note.runId === command.runId), [], "nothing is said about a start that happened");
  } finally {
    await stopAgentWorker(worker, agent, daemon);
  }
});
