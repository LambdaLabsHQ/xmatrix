import { createPgSpawnableScenario, isSpawnOf, runHubCommand as run, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import { assert, channelHistory, mintAgentRunToken, MOCK_TOKEN, postChannelMessage, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";

const program = source => `Run this review.\n\n\`\`\`norn run\n${source}\n\`\`\``;
const until = async (read, what) => {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test("a program in a message asks an Agent, takes its typed answer, and tells the conversation how it ended", async () => {
  const ownerId = `norn-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: ownerId,
    XMATRIX_MOCK_AUTH_EMAIL: "norn@example.com", XMATRIX_MOCK_AUTH_NAME: "Norn" } });
  let daemon;
  try {
    const scenario = await createPgSpawnableScenario(worker, { agentName: "codex" });
    ({ daemon } = scenario);
    const { channelId, registration } = scenario;
    const messages = async () => (await channelHistory(worker, MOCK_TOKEN, channelId, 50)).messages;

    // A program that does not check starts nothing, and its author reads where it is wrong.
    const wrong = (await postChannelMessage(worker, MOCK_TOKEN, channelId, program(`run(@codex, "Review")`))).message;
    const refusal = await until(async () => (await messages()).find(message => message.replyToMessageId === wrong.messageId), "the refusal");
    assert.match(refusal.body, /The program was not started/u);

    const sent = (await postChannelMessage(worker, MOCK_TOKEN, channelId, program(`type verdict = Sound | Flawed(string)
switch run(@codex, "Review the design")->wait {
| Answered(Sound) => "sound"
| Answered(Flawed(why)) => why
| other => fail(other)
}`))).message;
    const delivery = await until(async () => (await messages()).find(message =>
      message.replyToMessageId === sent.messageId && message.body.startsWith("@codex launch:force")), "the delivery");
    const requestRef = /Request `(r[a-z0-9]+)`/u.exec(delivery.body)?.[1];
    assert.ok(requestRef, delivery.body);
    assert.match(delivery.body, /verdict = Sound \| Flawed\(string\)/u);
    const spawn = await daemon.inbox.waitFor(message => message.type === "machine_spawn_agent" &&
      message.channelId === channelId && isSpawnOf(message, registration), "the holder's spawn");
    const runToken = await mintAgentRunToken(worker, daemon, spawn, channelId);

    // It reads its request before its first turn, not the conversation the program was written in.
    const context = await (await worker.fetch(`/api/channels/${channelId}/launch-context?startedFor=${encodeURIComponent(delivery.messageId)}`,
      { headers: { Authorization: `Bearer ${runToken}` } })).json();
    assert.match(context.startedForPrompt, /Review the design/u);
    assert.doesNotMatch(context.text ?? "", /Run this review/u);
    // The Run the delivery started holds the request; nobody else answers it.
    const listed = await run(worker, runToken, ["requests"]);
    assert.match(listed.stdout, new RegExp(`You hold:\\n  ${requestRef}\\t`, "u"));
    assert.match((await run(worker, MOCK_TOKEN, ["reply", requestRef, "Sound"])).stderr, /Agent Run/u);
    const outside = await run(worker, runToken, ["reply", requestRef, "Fine"]);
    assert.equal(outside.exitCode, 1);
    assert.match(outside.stderr, /The report must be verdict/u);
    const answered = await run(worker, runToken, ["reply", requestRef, "Flawed(\"no owner on failure\")"]);
    assert.deepEqual([answered.exitCode, answered.stdout], [0, "Recorded. The request is closed, and its program has ended.\n"]);
    assert.match((await run(worker, runToken, ["reply", requestRef, "Sound"])).stderr, /already ended/u);

    const ended = await until(async () => (await messages()).find(message =>
      message.replyToMessageId === sent.messageId && message.body.startsWith("The program finished")), "the program's end");
    assert.equal(ended.body, "The program finished: no owner on failure");
    // The Run was started for that one request: once it has ended, its Machine is told to stop it.
    const stop = await daemon.inbox.waitFor(message => message.type === "machine_stop_agent" && message.runId === spawn.runId, "the holder's stop");
    assert.equal(stop.runId, spawn.runId);
  } finally {
    daemon?.ws.close();
    await worker.stop();
  }
});
