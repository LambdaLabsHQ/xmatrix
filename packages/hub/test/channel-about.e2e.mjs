import {
  assert,
  channelHistory,
  json,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  test,
} from "./agent-mention-spawn.fixture.mjs";
import { connectDaemon, createClosedChannel, createRoutableAgent, homeSpaceId, REGISTERED_DAEMON_CAPABILITIES,
  startPgHubWorker, testMachine } from "./agent-launch-postgres.fixture.mjs";
import { Client } from "pg";

async function channelRowCount(connectionString, channelId) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query("SELECT count(*)::integer AS count FROM data.channels WHERE channel_id=$1",
      [channelId]);
    return result.rows[0].count;
  } finally { await client.end(); }
}

// Every worker runs the singleton Launch coordinator, which claims every
// eligible Launch in its database. Sharing one database once let a concurrent
// test's coordinator claim another suite's fresh Launch, settle it
// daemon-offline (its daemon socket lives in the other worker) and defer it 30s.
test("concurrent PostgreSQL test workers never share the database their Launch coordinators claim from", async () => {
  const userId = `pg-worker-isolation-e2e-${randomUUID()}`;
  const vars = { XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "pg-worker-isolation-e2e@example.com", XMATRIX_MOCK_AUTH_NAME: "PG Worker Isolation" };
  const [first, second] = await Promise.all([startPgHubWorker({ vars }), startPgHubWorker({ vars })]);
  try {
    assert.notEqual(first.postgresUrl, second.postgresUrl);
    const created = await json(await first.fetch("/api/channels", {
      method: "POST",
      headers: { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ spaceId: await homeSpaceId(first), mode: "closed", name: `pg-worker-isolation-${randomUUID()}`, access: [] }),
    }));
    assert.equal(await channelRowCount(first.postgresUrl, created.channel.id), 1);
    assert.equal(await channelRowCount(second.postgresUrl, created.channel.id), 0);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

// A conversation's About is one text task on the Machine of someone who reads the conversation:
// the harness is handed that conversation and nothing else, and xMatrix writes its answer.
test("a conversation's About is written by xMatrix from one text task that reads only that conversation", async () => {
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: `channel-about-e2e-${randomUUID()}`,
    XMATRIX_MOCK_AUTH_EMAIL: "channel-about-e2e@example.com", XMATRIX_MOCK_AUTH_NAME: "Channel About E2E",
  } });
  let daemon;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const { hostId, machineId } = testMachine("channel-about");
    const root = await createClosedChannel(worker, `channel-about-root-${randomUUID()}`);
    const language = await worker.fetch(`/api/spaces/${encodeURIComponent(root.spaceId)}`, {
      method: "PATCH", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ metadata: { locale: { defaultLocale: "zh-CN", supportedLocales: ["zh-CN", "en"] } } }),
    });
    assert.equal(language.status, 200, await language.clone().text());
    daemon = await connectDaemon(worker, { machineId, hostId,
      capabilities: [...REGISTERED_DAEMON_CAPABILITIES, "machine_text_task_v1", "machine_quota_probe_v2"] });
    await createRoutableAgent(worker, { spaceId: root.spaceId, name: `channel-about-${randomUUID()}`, machineId, hostId });
    const foreign = await createClosedChannel(worker, `foreign-${randomUUID()}`);
    await postChannelMessage(worker, MOCK_TOKEN, foreign.id, "Foreign plan nobody else may read");

    const task = (prefix, label) => daemon.inbox.waitFor((message) => message.type === "machine_text_task" &&
      message.requestId.startsWith(`channel-about:${root.id}:${prefix}`), label);
    const answer = async (command, text) => {
      daemon.ws.send(JSON.stringify({ type: "machine_text_task_result", requestId: command.requestId,
        result: { presetId: command.presetId, status: "completed", text },
        ...(command.relayLease ? { relayLease: command.relayLease } : {}) }));
      await daemon.inbox.waitFor((message) => message.type === "machine_command_completion_acked" &&
        message.requestId === command.requestId, `answer to ${command.requestId}`);
    };
    const revisions = async () => (await json(await worker.fetch(
      `/api/channels/${encodeURIComponent(root.id)}/metadata-history`, { headers: auth }))).revisions;

    // The fifth message reads the conversation; a named one is not renamed.
    const firstTask = task("0:5:summary:", "the About task for the fifth message");
    const evidence = [];
    for (let index = 1; index <= 5; index += 1) {
      evidence.push((await postChannelMessage(worker, MOCK_TOKEN, root.id, `Channel About evidence ${index}`)).message);
    }
    const first = await firstTask;
    assert.equal(first.presetId, "codex");
    assert.match(first.input, /Channel About evidence 1[\s\S]*Channel About evidence 5/u);
    assert.doesNotMatch(first.input, /Foreign plan/u, "another conversation never reaches the harness");
    assert.match(first.instruction, /Simplified Chinese/u, "the Space's language, not the conversation's");
    assert.deepEqual((await channelHistory(worker, MOCK_TOKEN, root.id)).messages.map((message) => message.messageId),
      evidence.map((message) => message.messageId), "asking for the About posts nothing");

    const summary = "自动整理频道 About 的端到端验证。";
    await answer(first, `\`\`\`json\n${JSON.stringify({ summary, name: "Not asked for" })}\n\`\`\``);
    const [written] = await revisions();
    assert.equal(written.summary, summary);
    assert.equal(written.name, root.name, "a name nobody asked for is not written");
    assert.equal(written.source_json.kind, "about_task");
    assert.equal(written.source_json.taskId, first.requestId);
    const [listed] = (await json(await worker.fetch(`/api/channels?familyOfChannelId=${encodeURIComponent(root.id)}`,
      { headers: auth }))).channels;
    assert.deepEqual(listed.summarySource, { author: { kind: "task", agentName: "codex" },
      generatedAt: listed.summarySource.generatedAt, throughSequence: 5 });

    // A person's change made after a reading stands; that reading's answer is not written.
    const secondTask = task("1:10:summary:", "the About task for the tenth message");
    for (let index = 6; index <= 10; index += 1) {
      await postChannelMessage(worker, MOCK_TOKEN, root.id, `Channel About evidence ${index}`);
    }
    const second = await secondTask;
    const renamed = await worker.fetch(`/api/channels/${encodeURIComponent(root.id)}`, {
      method: "PATCH", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: `renamed-${randomUUID()}` }),
    });
    assert.equal(renamed.status, 200, await renamed.clone().text());
    await answer(second, JSON.stringify({ summary: "An About read before the rename" }));
    const [afterRename] = await revisions();
    assert.equal(afterRename.source_json.kind, "edit");
    assert.equal(afterRename.summary, summary);

    // Asking for it again reads the conversation anew.
    const askedTask = task("2:10:summary:", "the About task asked for");
    const asked = await worker.fetch(`/api/spaces/${encodeURIComponent(root.spaceId)}/channel-about`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ channelId: root.id }),
    });
    assert.equal(asked.status, 200, await asked.clone().text());
    assert.deepEqual(await asked.json(), { accepted: true });
    await answer(await askedTask, JSON.stringify({ summary: "频道 About 已按最新消息重写。" }));
    assert.equal((await revisions())[0].summary, "频道 About 已按最新消息重写。");
  } finally {
    if (daemon) daemon.ws.close();
    await worker.stop();
  }
});
