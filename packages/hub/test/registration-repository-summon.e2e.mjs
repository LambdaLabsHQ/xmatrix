import { xmatrixRepositoryInstallation, startGitHubUserWorker } from "./support/github-user-worker.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  admitRegisteredSpawn, connectAgent, connectDaemon, createRoutableAgent, homeSpaceId, json, MOCK_TOKEN,
  randomUUID,
} from "./agent-launch-postgres.fixture.mjs";
import { waitForChannelHistoryMessage } from "./agent-mention-spawn.fixture.mjs";

const original = "@auto repo:LambdaLabsHQ/xmatrix machine:machine:1ed7a77b320f7b8d6831676d28618b0611cb2eaf4adacf0e445417434f3703e0 ";
// Model and harness names are orthogonal: `model:codex` asks for a model named
// "codex", which no registration offers, so it is refused as unavailable.
const harnessNamedModel = "@auto model:codex repo:LambdaLabsHQ/xmatrix machine:machine:1ed7a77b320f7b8d6831676d28618b0611cb2eaf4adacf0e445417434f3703e0 ";
const installationId = "fixture-installation";

test("a repository summon launches without a catalog read or repository grant, and its Agent connects", async () => {
  const userId = `repository-canary-${randomUUID()}`;
  const github = await xmatrixRepositoryInstallation(installationId);
  let worker, daemon, agent;
  try {
    worker = await startGitHubUserWorker({ id: userId, email: "repository-canary@example.com", name: "Repository Canary" }, github.url);
    const headers = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const machineId = "machine:1ed7a77b320f7b8d6831676d28618b0611cb2eaf4adacf0e445417434f3703e0", hostId = `repository-host-${randomUUID()}`;
    const spaceId = await homeSpaceId(worker);
    const { channel } = await json(await worker.fetch("/api/channels", { method: "POST", headers,
      body: JSON.stringify({ spaceId, mode: "closed", name: `repository-canary-${randomUUID()}`, access: [] }) }));
    daemon = await connectDaemon(worker, { machineId, hostId });
    await createRoutableAgent(worker, { token: MOCK_TOKEN, spaceId, name: "codex", machineId, hostId });
    const post = () => worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/messages`, {
      method: "POST", headers, body: JSON.stringify({ body: original }) });
    // A named repository is passed to the runtime as the repository to work
    // in: no catalog read and no repository grant come before the launch.
    const pending = daemon.inbox.waitFor(message => message.type === "machine_spawn_agent" && message.channelId === channel.id,
      "original repository summon spawn");
    const first = await post();
    assert.equal(first.status, 200, await first.clone().text());
    const command = await pending;
    assert.equal(command.prompt, original);
    assert.equal(command.registration.key.harness, "codex");
    assert.deepEqual(command.registration.resources.workspaces, ["repo:LambdaLabsHQ/xmatrix"]);
    assert.equal(command.remoteRepo, "LambdaLabsHQ/xmatrix");
    assert.equal(command.runWorktree, true);
    // The web draws a summon's status, steps and Jev decision on the launch
    // whose sourceMention is that summon, exactly as a refusal is matched.
    const launched = await json(await worker.fetch(
      `/api/channels/${encodeURIComponent(channel.id)}/agent-launches/query`, { method: "POST", headers,
        body: JSON.stringify({ sourceMessageIds: [(await first.json()).message.messageId], pageSize: 20 }) }));
    assert.equal(launched.launches.length, 1);
    assert.equal(launched.launches[0].sourceMention, original.trimEnd());
    const named = await json(await worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/messages`, {
      method: "POST", headers, body: JSON.stringify({ body: harnessNamedModel }) }));
    const namedDiagnostic = await json(await worker.fetch("/api/invocations/diagnostics", { method: "POST", headers,
      body: JSON.stringify({ channelId: channel.id, sourceMessageIds: [named.message.messageId] }) }));
    assert.equal(namedDiagnostic.rejections[0].code, "registration_model_unavailable");
    assert.deepEqual(namedDiagnostic.launches, []);
    const token = await admitRegisteredSpawn(worker, daemon, command);
    agent = await connectAgent(worker, { identityId: command.instanceId, name: command.agentName, agentType: "codex",
      metadata: { tool: "codex", machineId, hostId, workspaceMachineId: machineId,
        workspaceCwd: command.workspace.canonicalCwd, cwd: command.workspace.canonicalCwd,
        runId: command.runId, executionKey: command.executionKey, autoJoinChannelId: channel.id } }, token);
    assert.equal((await agent.request({ type: "join_channel", channelId: channel.id, historyLimit: 0 })).type, "channel_joined");
    const reply = "original repository summon is ready";
    assert.equal((await agent.request({ type: "channel_message", channelId: channel.id, body: reply })).type, "channel_message_dispatched");
    await waitForChannelHistoryMessage(worker, MOCK_TOKEN, channel.id, message => message.body === reply, "repository Agent reply");
  } finally {
    agent?.ws?.close();
    daemon?.ws?.close();
    await worker?.stop();
    await github.close();
  }
});
