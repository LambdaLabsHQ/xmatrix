import { channelSpaceId, createPgSpawnableScenario, inTestTransaction, isSpawnOf, runHubCommand as run, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import { assert, channelHistory, mintAgentRunToken, MOCK_TOKEN, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";

const block = (source, tag = "norn run review") => `\`\`\`${tag}\n${source}\n\`\`\``;
const REVIEW = `type verdict = Sound | Flawed(string)
switch run(@codex, "Review the design")->wait {
| Answered(Sound) => "sound"
| Answered(Flawed(why)) => why
| other => fail(other)
}`;

/** A Hub worker with one person, a Machine that can start `codex`, and that person's calls to the Space's pages. */
async function pageScene(name, body) {
  const worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: `${name}-${randomUUID()}`,
    XMATRIX_MOCK_AUTH_EMAIL: `${name}@example.com`, XMATRIX_MOCK_AUTH_NAME: "Norn Page" } });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex" });
    ({ daemon } = scenario);
    const call = async (path, method = "GET", payload) => {
      const response = await worker.fetch(path, { method, headers: { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const until = async (read, what) => {
      for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    await body({ worker, scenario, daemon, call, until,
      pages: `/api/spaces/${encodeURIComponent(await channelSpaceId(scenario.channelId))}/pages` });
  } finally {
    daemon?.ws.close();
    await worker.stop();
  }
}

test("a program block on a page runs in a conversation of its own, and the page says how it stands", () => pageScene("norn-page", async ({ worker, scenario, daemon, call, pages, until }) => {
    // A block that does not check starts nothing, and the page says why.
    const { page } = await call(pages, "POST", { title: "Design", body: `# Design\n\n${block(`run(@codex, "Review")`)}\n` });
    const programs = async () => (await call(`${pages}/${page.pageId}/programs`)).programs;
    assert.deepEqual((await programs()).map(program => [program.name, program.state, Boolean(program.problem)]), [["review", "not_started", true]]);

    // Saved with a program that checks, the page starts it in a conversation named for the page and the block.
    const edit = async body => call(`${pages}/${page.pageId}`, "PUT", { body, baseRevision: (await call(`${pages}/${page.pageId}`)).page.headRevision });
    await edit(`# Design\n\n${block(REVIEW)}\n`);
    const running = await until(async () => (await programs()).find(program => program.state === "running" && program.requests.length), "the program");
    assert.deepEqual(running.requests.map(request => [request.holder, request.text, request.reply]), [["@codex", "Review the design", null]]);
    const spawn = await daemon.inbox.waitFor(message => message.type === "machine_spawn_agent" &&
      message.channelId === running.channelId && isSpawnOf(message, scenario.registration), "the holder's spawn");
    const history = await channelHistory(worker, MOCK_TOKEN, running.channelId, 20);
    assert.match(history.messages[0].body, /^```norn\n/u);
    const delivery = history.messages.find(message => message.body.startsWith("@codex launch:force"));
    const requestRef = /`request:(r[a-z0-9]+)`/u.exec(delivery.body)[1];

    // An edit that leaves the program's text alone changes nothing; the same request stands.
    await edit(`# Design\n\nA note.\n\n${block(REVIEW)}\n`);
    const runToken = await mintAgentRunToken(worker, daemon, spawn, running.channelId);
    assert.equal((await run(worker, runToken, ["reply", requestRef, "Flawed(\"no owner\")"])).exitCode, 0);
    const ended = await until(async () => (await programs()).find(program => program.state === "completed"), "the program's end");
    assert.deepEqual([ended.result, ended.requests.map(request => request.reply)], ["no owner", ["Flawed(no owner)"]]);

    // Changed after it ended, the block runs again in the same conversation; removed, its program stops.
    await edit(`# Design\n\n${block(REVIEW.replace("Review the design", "Review the design again"))}\n`);
    const again = await until(async () => (await programs()).find(program => program.state === "running" && program.requests.length), "the second run");
    assert.deepEqual([again.channelId, again.requests.map(request => request.text)], [running.channelId, ["Review the design again"]]);
    await edit("# Design\n\nNo program.\n");
    assert.deepEqual(await programs(), []);
    await until(async () => (await channelHistory(worker, MOCK_TOKEN, running.channelId, 30)).messages
      .some(message => message.body === "Stopped: Removed from its page"), "the stop");
}));

test("a page's program asks the same participant again where it already is, and that Agent stays when the program ends", () => pageScene("norn-reuse", async ({ worker, scenario, daemon, call, pages, until }) => {
    const { page } = await call(pages, "POST", { title: "Two steps", body: block(`let draft = ask(@codex, "Draft it")->wait?
ask(@codex, "Now shorten it", ~about=draft)->wait`, "norn run") });
    const program = async () => (await call(`${pages}/${page.pageId}/programs`)).programs[0];
    const running = await until(async () => { const now = await program(); return now?.requests.length ? now : null; }, "the first request");
    const deliveries = async () => (await channelHistory(worker, MOCK_TOKEN, running.channelId, 30)).messages
      .filter(message => /`request:r[a-z0-9]+`/u.test(message.body));
    const spawn = await daemon.inbox.waitFor(message => message.type === "machine_spawn_agent" &&
      message.channelId === running.channelId && isSpawnOf(message, scenario.registration), "the holder's spawn");
    const runToken = await mintAgentRunToken(worker, daemon, spawn, running.channelId);
    // Its Instance is there and takes messages, as a connected one is.
    await inTestTransaction(tx => tx.query({ text: "UPDATE data.instances SET status='idle' WHERE run_id=$1", values: [spawn.runId] }));
    const [first] = await deliveries();
    assert.match(first.body, /You stay in this conversation afterwards/u);
    assert.equal((await run(worker, runToken, ["reply", /`request:(r[a-z0-9]+)`/u.exec(first.body)[1], "A long draft"])).exitCode, 0);

    // The second request goes to that Instance by its address: no new Run starts, and the same Run answers it.
    const second = await until(async () => (await deliveries())[1], "the second delivery");
    assert.match(second.body, /^@codex:\d+\n/u);
    assert.doesNotMatch(second.body, /launch:force/u);
    await assert.rejects(daemon.inbox.waitFor(message => message.type === "machine_spawn_agent" && message.runId !== spawn.runId,
      "a second spawn", 1_500), /waiting for a second spawn/u);
    const held = await run(worker, runToken, ["requests"]);
    const requestRef = /`request:(r[a-z0-9]+)`/u.exec(second.body)[1];
    assert.match(held.stdout, new RegExp(`You hold:\\n  ${requestRef}\\t`, "u"));
    assert.equal((await run(worker, runToken, ["reply", requestRef, "Short"])).exitCode, 0);
    assert.equal((await until(async () => { const now = await program(); return now.state === "completed" ? now : null; }, "the end")).result, "Short");
    // What it answered stands in the conversation under its own name, and the end does not say it again.
    const { messages } = await channelHistory(worker, MOCK_TOKEN, running.channelId, 30);
    assert.deepEqual(messages.filter(message => message.from.kind === "agent").map(message => message.body), ["A long draft", "Short"]);
    await until(async () => (await channelHistory(worker, MOCK_TOKEN, running.channelId, 30)).messages
      .find(message => message.body === "Finished."), "the program's end");
    // The Agent that worked last stays in the conversation: whoever writes there next reaches it.
    await assert.rejects(daemon.inbox.waitFor(message => message.type === "machine_stop_agent" && message.runId === spawn.runId,
      "the holder's stop", 2_000), /waiting for the holder's stop/u);
}));

test("what a program says is posted to its conversation, for whom it names", () => pageScene("norn-say", async ({ worker, call, pages, until }) => {
  const { page } = await call(pages, "POST", { title: "Reminders", body: block(`say(@codex, "The renewal is due on Friday")`, "norn run remind") });
  const program = await until(async () => (await call(`${pages}/${page.pageId}/programs`)).programs.find(each => each.state === "completed"), "the program's end");
  const said = await until(async () => (await channelHistory(worker, MOCK_TOKEN, program.channelId, 20)).messages
    .find(message => message.body === "@codex The renewal is due on Friday"), "what it said");
  assert.equal(said.from.kind, "system");
}));

test("work on a page's program that breaks off is handed on once; failing again, its saver is told where it stopped and waited on", () => pageScene("norn-broke", async ({ worker, call, pages, until }) => {
  // No Machine by that name runs the Agent, so no Run ever takes the request.
  const { page } = await call(pages, "POST", { title: "Cleanup", body: block(`run(@codex(~machine="absent"), "Delete the old builds")->wait`, "norn run cleanup") });
  const failed = await until(async () => (await call(`${pages}/${page.pageId}/programs`)).programs.find(program => program.state === "failed"), "the failure");
  const end = await until(async () => (await channelHistory(worker, MOCK_TOKEN, failed.channelId, 30)).messages
    .find(message => message.body.includes("This stopped before it was finished")), "the program's end");
  const { messages } = await channelHistory(worker, MOCK_TOKEN, failed.channelId, 30);
  // The same request was delivered twice, the second time with what the first attempt left to read.
  const deliveries = messages.filter(message => /`request:r[a-z0-9]+`/u.test(message.body));
  assert.deepEqual(deliveries.map(message => /An earlier attempt at this request broke off/u.test(message.body)), [false, true]);
  assert.equal(new Set(deliveries.map(message => /`request:(r[a-z0-9]+)`/u.exec(message.body)[1])).size, 1);
  assert.match(end.body, /This stopped before it was finished: codex, asked “Delete the old builds”, did not finish: .*the second time on a new Instance\. Nothing more happens by itself: say here what to do next\.$/u);
  // Nobody answered a card of this program, so whoever saved it is the one it waits on.
  const waits = await inTestTransaction(tx => tx.query({ text: `SELECT a.subject_id,a.awaiting_response FROM data.message_attention a
    WHERE a.message_id=$1`, values: [end.messageId ?? end.id] }));
  assert.deepEqual(waits.map(wait => [wait.subject_id.startsWith("user:norn-broke-"), wait.awaiting_response]), [[true, true]]);
}));
