import {
  connectTestRuntime,
  prepareTestAgentRun,
} from "./e2e-utils.mjs";
import {
  assert,
  json,
  makeInbox,
  postChannelMessage,
  randomUUID,
  sleep,
  test,
  waitForChannelHistoryMessage,
} from "./agent-mention-spawn.fixture.mjs";
import {
  acceptSpaceInvite, createSpace, inviteToSpace, daemonIdentity, startPgHubWorker,
} from "./agent-launch-postgres.fixture.mjs";

test("a non-owner channel member's /kill all stops every live instance in that channel", async () => {
  const unique = randomUUID();
  const ownerToken = `kill-all-owner-${unique}`;
  const memberToken = `kill-all-member-${unique}`;
  const ownerUserId = `kill-all-owner-user-${unique}`;
  const memberUserId = `kill-all-member-user-${unique}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
        [ownerToken]: {
          id: ownerUserId,
          email: `${ownerUserId}@example.com`,
          name: "Kill All Owner",
        },
        [memberToken]: {
          id: memberUserId,
          email: `${memberUserId}@example.com`,
          name: "Kill All Member",
        },
      }),
    },
  });
  let ownerDaemon;
  let memberDaemon;
  let ownerAgent;
  let memberAgent;
  try {
    const ownerAuth = {
      Authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json",
    };
    const space = await createSpace(worker, `Kill all ${unique}`, ownerToken);
    await acceptSpaceInvite(worker, await inviteToSpace(worker, space.id, ownerToken), memberToken);
    const channel = (await json(await worker.fetch("/api/channels", {
      method: "POST",
      headers: ownerAuth,
      body: JSON.stringify({
        spaceId: space.id,
        mode: "open",
        name: `kill-all-${unique}`,
      }),
    }))).channel;
    const ownerMachineId = `machine:kill-all-owner-${unique}`;
    const ownerHostId = `kill-all-owner-host-${unique}`;
    const memberMachineId = `machine:kill-all-member-${unique}`;
    const memberHostId = `kill-all-member-host-${unique}`;
    ownerDaemon = await connectTestRuntime(worker, daemonIdentity({ machineId: ownerMachineId, hostId: ownerHostId }), ownerToken, makeInbox);
    memberDaemon = await connectTestRuntime(worker, daemonIdentity({ machineId: memberMachineId, hostId: memberHostId }), memberToken, makeInbox);

    const ownerRun = await prepareTestAgentRun(worker, {
      spaceId: space.id,
      targetChannelId: channel.id,
      name: `owner-agent-${unique}`,
      agentType: "codex",
      metadata: {
        tool: "codex",
        machineId: ownerMachineId,
        hostId: ownerHostId,
        hostName: ownerHostId,
      },
    }, ownerToken);
    ownerAgent = await connectTestRuntime(
      worker,
      ownerRun.body,
      ownerRun.token,
      makeInbox,
    );
    const memberRun = await prepareTestAgentRun(worker, {
      spaceId: space.id,
      targetChannelId: channel.id,
      name: `member-agent-${unique}`,
      spaceAdminToken: ownerToken,
      agentType: "codex",
      metadata: {
        tool: "codex",
        machineId: memberMachineId,
        hostId: memberHostId,
        hostName: memberHostId,
      },
    }, memberToken);
    memberAgent = await connectTestRuntime(
      worker,
      memberRun.body,
      memberRun.token,
      makeInbox,
    );

    const ownerStopPromise = ownerDaemon.inbox.waitFor(
      (message) => message.type === "machine_stop_agent",
      "owner machine stop",
    );
    const memberStopPromise = memberDaemon.inbox.waitFor(
      (message) => message.type === "machine_stop_agent",
      "member machine stop",
    );
    // The append fences Hub activity immediately, while physical stops await
    // the independently authenticated results from both machine owners.
    const posting = postChannelMessage(worker, memberToken, channel.id, "/kill all")
      .then(result => ({ result }), error => ({ error }));
    const stops = await Promise.all([ownerStopPromise, memberStopPromise]);
    const killAll = await waitForChannelHistoryMessage(
      worker, memberToken, channel.id,
      (message) => message.body === "/kill all",
      "kill-all command",
    );
    const memberHeaders = { Authorization: `Bearer ${memberToken}`, "content-type": "application/json" };
    const stopReceipts = async () => {
      const page = await json(await worker.fetch(
        `/api/channels/${encodeURIComponent(channel.id)}/agent-launches/query`,
        { method: "POST", headers: memberHeaders, body: JSON.stringify({ sourceMessageIds: [killAll.messageId] }) },
      ));
      return page.stops ?? [];
    };
    const accepted = await stopReceipts();
    assert.equal(accepted.length, 2, JSON.stringify(accepted));
    assert.ok(accepted.every((stop) => stop.phase === "accepted" && stop.sourceMessageId === killAll.messageId));
    for (const [daemon, stop] of [[ownerDaemon, stops[0]], [memberDaemon, stops[1]]]) {
      const response = await worker.fetch("/api/daemon/control-result", {
        method: "POST",
        headers: { Authorization: `Bearer ${daemon.machineCredential}`, "content-type": "application/json" },
        body: JSON.stringify({
        type: "machine_stop_result",
        requestId: stop.requestId,
        runId: stop.runId,
        executionKey: stop.executionKey,
        agentId: stop.agentId,
        instanceId: stop.instanceId,
        ...Object.fromEntries(["resumeSessionKey", "daemonRequestId", "repoIdentity", "repoKeyId", "slotId",
          "worktreeDisposition"].filter((key) => stop[key] !== undefined).map((key) => [key, stop[key]])),
        ok: true,
        pid: 4242,
        relayLease: stop.relayLease,
        }),
      });
      assert.equal(response.status, 200, await response.text());
    }
    const posted = await posting;
    if (posted.error) throw posted.error;
    const deadline = Date.now() + 15_000;
    let confirmed = [];
    while (Date.now() < deadline) {
      confirmed = await stopReceipts();
      if (confirmed.length === 2 && confirmed.every((stop) => stop.phase === "confirmed")) break;
      await sleep(25);
    }
    assert.deepEqual(confirmed.map((stop) => stop.phase).sort(), ["confirmed", "confirmed"], JSON.stringify(confirmed));
    const history = await json(await worker.fetch(
      `/api/channels/${encodeURIComponent(channel.id)}/history?limit=50`,
      { headers: { Authorization: `Bearer ${memberToken}` } },
    ));
    const bodies = (history.messages || []).map((message) => message.body).filter((body) => typeof body === "string");
    assert.equal(bodies.some((body) => body.startsWith("Stop requested for")), false);
    assert.equal(bodies.some((body) => body.includes("process tree is terminated")), false);

  } finally {
    ownerAgent?.ws.close();
    memberAgent?.ws.close();
    ownerDaemon?.ws.close();
    memberDaemon?.ws.close();
    await worker.stop();
  }
});

test("an Agent run leaving its own channel stops that run", async () => {
  const unique = randomUUID();
  const ownerToken = `leave-owner-${unique}`;
  const ownerUserId = `leave-owner-user-${unique}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
        [ownerToken]: { id: ownerUserId, email: `${ownerUserId}@example.com`, name: "Leave Owner" },
      }),
    },
  });
  let daemon;
  let agent;
  try {
    const ownerAuth = { Authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
    const space = (await json(await worker.fetch("/api/spaces", {
      method: "POST", headers: ownerAuth, body: JSON.stringify({ name: `Leave ${unique}` }),
    }))).space;
    const createChannel = async (name) => (await json(await worker.fetch("/api/channels", {
      method: "POST", headers: ownerAuth, body: JSON.stringify({ spaceId: space.id, mode: "open", name }),
    }))).channel;
    const channel = await createChannel(`leave-${unique}`);
    const elsewhere = await createChannel(`leave-elsewhere-${unique}`);
    const machineId = `machine:leave-${unique}`;
    const hostId = `leave-host-${unique}`;
    daemon = await connectTestRuntime(worker, daemonIdentity({ machineId: machineId, hostId: hostId }), ownerToken, makeInbox);
    const run = await prepareTestAgentRun(worker, {
      spaceId: space.id,
      targetChannelId: channel.id,
      name: `leave-agent-${unique}`,
      agentType: "codex",
      metadata: { tool: "codex", machineId, hostId, hostName: hostId },
    }, ownerToken);
    agent = await connectTestRuntime(worker, run.body, run.token, makeInbox);
    const agentAuth = { Authorization: `Bearer ${run.token}`, "content-type": "application/json" };

    // A run lives in one Channel; it cannot leave, or stop itself from, another.
    const refused = await worker.fetch(`/api/channels/${encodeURIComponent(elsewhere.id)}/leave`, {
      method: "POST", headers: agentAuth,
    });
    assert.equal(refused.status, 403, await refused.clone().text());
    assert.equal((await refused.json()).code, "agent_run_channel_mismatch");

    const stopPromise = daemon.inbox.waitFor(
      (message) => message.type === "machine_stop_agent",
      "leave machine stop",
    );
    const left = await worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/leave`, {
      method: "POST", headers: agentAuth,
    });
    assert.equal(left.status, 200, await left.clone().text());
    assert.equal((await left.json()).stopping, true);
    const stop = await stopPromise;
    assert.equal(stop.channelId, channel.id);
    const notice = await waitForChannelHistoryMessage(
      worker,
      ownerToken,
      channel.id,
      (message) => (message.body || "").endsWith(" left the channel."),
      "leave notice",
    );
    assert.match(notice.body, /^@leave-agent-/u);
  } finally {
    agent?.ws.close();
    daemon?.ws.close();
    await worker.stop();
  }
});
