import { assert, json, MOCK_TOKEN, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";
import { channelSpaceId, createPgSpawnableScenario, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

// Live co-writing starts with the Hub's instruction in the conversation, which the Agent's runtime
// reads as it joins and acts on by joining the page (docs/design/pages-live-document.md §4.2). It is
// a system fact, nobody's work, and a stop is one too.
test("starting and stopping live co-writing tells the conversation's Agent to join the page and to leave it", async () => {
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: `co-writing-${randomUUID()}`,
    XMATRIX_MOCK_AUTH_EMAIL: "co-writing@example.com", XMATRIX_MOCK_AUTH_NAME: "Page Writer",
  } });
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const { channelId } = await createPgSpawnableScenario(worker, { agentName: "co-writer" });
    const spaceId = await channelSpaceId(channelId);
    const pages = `/api/spaces/${encodeURIComponent(spaceId)}/pages`;
    const page = (await json(await worker.fetch(pages, { method: "POST", headers: auth,
      body: JSON.stringify({ title: "Plan", body: "# Plan\n\n## Risks\n" }) }))).page;
    const linked = await worker.fetch(`/api/spaces/${encodeURIComponent(spaceId)}/page-links`, { method: "POST",
      headers: auth, body: JSON.stringify({ conversationId: channelId, pageId: page.pageId }) });
    assert.equal(linked.status, 200, await linked.clone().text());
    const coWriting = `${pages}/${encodeURIComponent(page.pageId)}/co-writing`;
    const instructions = async () => (await json(await worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/history?limit=50`, { headers: auth }))).messages
      .filter((message) => message.metadata?.xmatrixPageCoWrite)
      .map((message) => [message.from?.kind, message.metadata.xmatrixPageCoWrite]);

    const started = await worker.fetch(coWriting, { method: "POST", headers: auth,
      body: JSON.stringify({ conversationId: channelId, live: true }) });
    assert.equal(started.status, 200, await started.clone().text());
    assert.deepEqual(await instructions(), [
      ["system", { version: 1, spaceId, pageId: page.pageId, active: true }],
    ]);

    const stopped = await worker.fetch(`${coWriting}/${encodeURIComponent(channelId)}`, { method: "DELETE", headers: auth });
    assert.equal(stopped.status, 200, await stopped.clone().text());
    assert.deepEqual((await instructions()).map(([kind, instruction]) => [kind, instruction.active]),
      [["system", true], ["system", false]]);
    // Stopping again finds nothing to stop, and says nothing more.
    await worker.fetch(`${coWriting}/${encodeURIComponent(channelId)}`, { method: "DELETE", headers: auth });
    assert.equal((await instructions()).length, 2);
  } finally {
    await worker.stop();
  }
});
