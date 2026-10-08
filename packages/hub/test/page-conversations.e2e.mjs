import { assert, connectAgent, json, MOCK_TOKEN, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";
import {
  channelSpaceId, createPgSpawnableScenario, launchScenarioRun, startPgHubWorker,
} from "./agent-launch-postgres.fixture.mjs";

// A page shows each linked conversation beside what it is about, and each
// section names the Agents working in its conversations even when they do
// not have the page open (docs/design/pages-live-document.md §3.2, §4.4).
test("a page's links describe their conversations, and its sections name the Agents working in them", async () => {
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: `page-conversations-${randomUUID()}`,
    XMATRIX_MOCK_AUTH_EMAIL: "page-conversations@example.com", XMATRIX_MOCK_AUTH_NAME: "Page Reader",
  } });
  let daemon;
  let liveAgent;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const scenario = await createPgSpawnableScenario(worker, { agentName: "page-worker" });
    ({ daemon } = scenario);
    const { channelId } = scenario;
    const spaceId = await channelSpaceId(channelId);
    const page = (await json(await worker.fetch(`/api/spaces/${encodeURIComponent(spaceId)}/pages`, {
      method: "POST", headers: auth, body: JSON.stringify({ title: "Plan", body: "# Plan\n## Release\nNot yet\n" }),
    }))).page;
    const linked = await worker.fetch(`/api/spaces/${encodeURIComponent(spaceId)}/page-links`, { method: "POST",
      headers: auth, body: JSON.stringify({ conversationId: channelId, pageId: page.pageId, blockId: "release" }) });
    assert.equal(linked.status, 200, await linked.clone().text());
    const links = async () => json(await worker.fetch(
      `/api/spaces/${encodeURIComponent(spaceId)}/page-links?pageId=${encodeURIComponent(page.pageId)}`,
      { headers: auth }));
    const awareness = async () => json(await worker.fetch(
      `/api/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(page.pageId)}/awareness`,
      { headers: auth }));

    const before = await links();
    assert.deepEqual(before.conversations.map((conversation) => [conversation.conversationId, conversation.agents]),
      [[channelId, []]], "the linked conversation is described, with nobody live in it yet");
    assert.deepEqual((await awareness()).blocks.find((block) => block.blockId === "release").working, []);

    const prepared = await launchScenarioRun(worker, scenario, "Cut the release notes.");
    liveAgent = await connectAgent(worker, prepared.body, prepared.token);
    const joined = await liveAgent.request({ type: "join_channel", channelId, historyLimit: 0 });
    assert.equal(joined.type, "channel_joined");

    const [conversation] = (await links()).conversations;
    assert.equal(conversation.name, `pg-launch-${scenario.hostId.slice("pg-launch-host-".length)}`);
    assert.equal(conversation.lastMessage.from.kind, "user");
    assert.equal(conversation.lastMessage.from.label, "Page Reader");
    assert.match(conversation.lastMessage.bodyPreview, /Cut the release notes\.$/u);
    // The chat list previews the same newest message from its own catalog read.
    const catalog = await json(await worker.fetch(
      `/api/channels/page?spaceId=${encodeURIComponent(spaceId)}&view=flat&filter=all`, { headers: auth }));
    const row = catalog.rows.find((candidate) => candidate.channel.id === channelId);
    assert.equal(row.channel.headMessage, undefined, "the stored head never reaches clients");
    assert.equal(row.channel.lastMessage.from.label, "Page Reader");
    assert.match(row.channel.lastMessage.bodyPreview, /Cut the release notes\.$/u);
    assert.equal(row.channel.lastMessage.sequence, conversation.headSequence);
    assert.ok(conversation.headSequence >= 1);
    assert.ok(conversation.readSequence <= conversation.headSequence);
    assert.equal(conversation.agents.length, 1, JSON.stringify(conversation.agents));
    const [agent] = conversation.agents;
    assert.match(agent.name, /^page-worker:\d+$/u);
    assert.ok(["online", "busy", "idle"].includes(agent.status));

    const release = (await awareness()).blocks.find((block) => block.blockId === "release");
    assert.deepEqual(release.working, [{ name: agent.name, status: agent.status, conversationId: channelId }],
      "the section names the Agent working in its conversation, which does not have the page open");
    assert.deepEqual(release.present, []);

    const byConversation = await worker.fetch(`/api/spaces/${encodeURIComponent(spaceId)}/page-links?conversationId=${
      encodeURIComponent(channelId)}`, { headers: auth });
    assert.equal((await byConversation.json()).conversations, undefined, "only a page's links carry conversations");

    // The page tree counts open discussions only, and previews the newest message in them.
    const tree = async () => (await json(await worker.fetch(
      `/api/spaces/${encodeURIComponent(spaceId)}/page-links/agents`, { headers: auth }))).pages
      .find((item) => item.pageId === page.pageId);
    assert.equal((await tree())?.discussions.open ?? 0, 0, "a section's conversation is not an open discussion");
    const discussed = await worker.fetch(`/api/spaces/${encodeURIComponent(spaceId)}/page-links`, { method: "POST",
      headers: auth, body: JSON.stringify({ conversationId: channelId, pageId: page.pageId, blockId: "release",
        anchor: { quote: "Not yet", from: { assoc: 0 }, to: { assoc: 0 } } }) });
    assert.equal(discussed.status, 200, await discussed.clone().text());
    const { discussions } = await tree();
    assert.equal(discussions.open, 1);
    assert.equal(discussions.latest.from.label, "Page Reader");
    assert.match(discussions.latest.bodyPreview, /Cut the release notes\.$/u);
  } finally {
    liveAgent?.ws.close();
    daemon?.ws.close();
    await worker.stop();
  }
});
