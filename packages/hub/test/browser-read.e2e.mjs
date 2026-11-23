import { createPgSpawnableScenario, launchScenarioRun, runHubCommand as run, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import { assert, MOCK_TOKEN, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";
import { humanWsUrl, openWebSocket } from "./e2e-utils.mjs";
import { websocketInbox as inboxOf } from "./support/websocket-inbox.mjs";

// `xmatrix browse`: an Agent Run reads a page through its owner's browser. The request reaches the owner's live
// clients (the extension's side panel answers it); the Agent's call waits for that answer.
test("an Agent Run reads a page through its owner's browser, and only the owner answers", async () => {
  const ownerId = `browser-read-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
    XMATRIX_MOCK_AUTH_USER_ID: ownerId, XMATRIX_MOCK_AUTH_EMAIL: "browser-read@example.com",
    XMATRIX_MOCK_AUTH_NAME: "Browser Read" } });
  let daemon, ws;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex-browser-read" });
    ({ daemon } = scenario);
    const { channelId } = scenario;
    const { token: runToken } = await launchScenarioRun(worker, scenario, "Read the page.");

    // A person cannot use it: it is the Agent's way to the page.
    const human = await run(worker, MOCK_TOKEN, ["browse"]);
    assert.equal(human.exitCode, 1);
    assert.match(human.stderr, /requires an Agent Run/);

    // No client of the owner is connected: the Agent hears at once that the side panel is closed.
    const offline = await run(worker, runToken, ["browse"]);
    assert.equal(offline.exitCode, 1);
    assert.match(offline.stderr, /side panel is not open/);

    ws = await openWebSocket(humanWsUrl(worker, ownerId));
    const inbox = inboxOf(ws);
    ws.send(JSON.stringify({ type: "human_connect", token: MOCK_TOKEN, requestId: "connect-owner",
      device: { client: "desktop", version: "0.16.160", protocolVersion: 2 } }));
    await inbox.waitFor((message) => message.type === "human_connected", "owner connected");

    const answer = (requestId, body, token = MOCK_TOKEN) => worker.fetch(`/api/browser/read/${requestId}/answer`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

    // The conversation's own page.
    const reading = run(worker, runToken, ["browse"]);
    const asked = await inbox.waitFor((message) => message.type === "browser_read_requested", "read requested");
    assert.equal(asked.channelId, channelId);
    assert.equal(asked.target, "conversation");
    // The Run's token cannot answer its own request.
    assert.notEqual((await answer(asked.requestId, { refusal: "denied" }, runToken)).status, 200);
    const settled = await answer(asked.requestId, { title: "Pool sizing", href: "https://docs.example.test/pool", text: "Raise max_connections." });
    assert.equal(settled.status, 200);
    assert.deepEqual(await settled.json(), { settled: true });
    const read = await reading;
    assert.equal(read.exitCode, 0, read.stderr);
    assert.match(read.stdout, /# Pool sizing\nhttps:\/\/docs\.example\.test\/pool\n\nRaise max_connections\./);

    // Another tab, which the person declines.
    const other = run(worker, runToken, ["browse", "--tab", "https://mail.example.test/inbox"]);
    const second = await inbox.waitFor((message) => message.type === "browser_read_requested" &&
      message.target === "https://mail.example.test/inbox", "tab read requested");
    await answer(second.requestId, { refusal: "denied" });
    const declined = await other;
    assert.equal(declined.exitCode, 1);
    assert.match(declined.stderr, /did not allow reading that tab/);

    // An answer for no waiting request settles nothing; an unsafe address is refused outright.
    assert.deepEqual(await (await answer("req-nobody-waits", { refusal: "denied" })).json(), { settled: false });
    assert.equal((await answer("req-nobody-waits", { title: "x", href: "file:///etc/passwd", text: "x" })).status, 400);
  } finally {
    ws?.close();
    daemon?.ws.close();
    await worker.stop();
  }
});
