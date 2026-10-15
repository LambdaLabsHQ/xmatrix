import { assert, json, MOCK_TOKEN, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";
import { launchMentionedCodexRun, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

// Live co-writing starts with the Hub's instruction in the conversation, which the Agent's runtime
// reads as it joins and acts on by joining the page (docs/design/pages-live-document.md §4.2). It is
// a system fact, nobody's work, and a stop is one too.
test("starting and stopping live co-writing tells the conversation's Agent to join the page and to leave it", async () => {
  const userId = `co-writing-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "co-writing@example.com", XMATRIX_MOCK_AUTH_NAME: "Page Writer",
  } });
  let daemon;
  let agent;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const run = await launchMentionedCodexRun(worker, { ownerUserId: userId, slug: "co-writing",
      displayName: "co-writer", mention: "@codex co-write this page" });
    ({ daemon, agent } = run);
    const { spaceId, runToken } = run;
    const channelId = run.channel.id;
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

    // The actual Run credential must reach the Page route, which authorizes
    // that live Run and its owner's access before minting a one-use ticket.
    const asRun = { Authorization: `Bearer ${runToken}`, "content-type": "application/json" };
    const live = `${pages}/${encodeURIComponent(page.pageId)}/live`;
    const ticket = (headers, body = { document: "prosemirror", coWrite: true }) => worker.fetch(live,
      { method: "POST", headers, body: JSON.stringify(body) });
    const joined = await ticket(asRun);
    assert.equal(joined.status, 200, await joined.clone().text());
    const { protocol, socketPath, canEdit } = await joined.json();
    assert.match(protocol, /^xmatrix-page-/u);
    assert.equal(socketPath, `/ws/pages/${spaceId}/${page.pageId}`);
    assert.equal(canEdit, true);
    assert.equal((await ticket(auth)).status, 403, "people do not join as a Run");
    assert.equal((await ticket(asRun, { document: "prosemirror" })).status, 403,
      "a Run cannot bypass the co-writer protocol with raw document sync");
    const suggestOnly = await worker.fetch(`${pages}/${encodeURIComponent(page.pageId)}`, { method: "PATCH",
      headers: auth, body: JSON.stringify({ agentSuggestOnly: true }) });
    assert.equal(suggestOnly.status, 200, await suggestOnly.clone().text());
    const refused = await ticket(asRun);
    assert.equal(refused.status, 409, await refused.clone().text());
    assert.equal((await refused.json()).code, "page_co_writing_suggest_only");
    const invalid = await ticket({ ...asRun, Authorization: "Bearer invalid-run-credential" });
    assert.equal(invalid.status, 401, "invalid credentials never mint tickets");

    const stopped = await worker.fetch(`${coWriting}/${encodeURIComponent(channelId)}`, { method: "DELETE", headers: auth });
    assert.equal(stopped.status, 200, await stopped.clone().text());
    assert.deepEqual((await instructions()).map(([kind, instruction]) => [kind, instruction.active]),
      [["system", true], ["system", false]]);
    // Stopping again finds nothing to stop, and says nothing more.
    await worker.fetch(`${coWriting}/${encodeURIComponent(channelId)}`, { method: "DELETE", headers: auth });
    assert.equal((await instructions()).length, 2);
  } finally {
    agent?.ws?.close();
    daemon?.ws?.close();
    await worker.stop();
  }
});
