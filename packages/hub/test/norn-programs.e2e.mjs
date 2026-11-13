import { createPgSpawnableScenario, inTestTransaction, isSpawnOf, runHubCommand as run, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
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
    // Mock authentication creates no account row, and a person is found by the name their account carries.
    await inTestTransaction(tx => tx.query({ text: `INSERT INTO control.auth_users (id,name,email,handle,profile_version,created_at,updated_at)
      VALUES ($1,'Norn','norn@example.com','norn',1,now(),now()) ON CONFLICT (id) DO NOTHING`, values: [ownerId] }));
    const answer = (ref, body, token = MOCK_TOKEN) => worker.fetch(`/api/channels/${channelId}/norn-requests/${ref}/answer`,
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

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
    // The Run asks a person with a command instead of a program of its own: the question is a card for them,
    // silence has the meaning the Run gave it, and the answer comes back to the Run by its address.
    assert.match((await run(worker, runToken, ["choose", "@Norn", "Which path?", "fast"])).stderr, /two or more different options/u);
    assert.match((await run(worker, runToken, ["confirm", "@Norn", "Use", "the", "fast", "path?", "--by", "1d", "--otherwise", "No"])).stdout, /^Asked\./u);
    const question = await until(async () => (await messages()).find(message =>
      message.messageResidual?.appMetadata?.nornRequest?.text === "Use the fast path?"), "the Run's question");
    assert.equal((await (await answer(question.messageResidual.appMetadata.nornRequest.ref, { outcome: "answered", text: "Yes" })).json()).status, "completed");
    const back = await until(async () => (await messages()).find(message => /^@codex:\d+ The program finished: Answered\(Yes\)$/u.test(message.body)),
      "the answer coming back to the Run");
    assert.ok((await messages()).some(message => message.body.startsWith("codex asks Norn:\n\n```norn run\nswitch confirm")), back.body);

    const answered = await run(worker, runToken, ["reply", requestRef, "Flawed(\"no owner on failure\")"]);
    assert.deepEqual([answered.exitCode, answered.stdout], [0, "Recorded. The request is closed, and its program has ended.\n"]);
    assert.match((await run(worker, runToken, ["reply", requestRef, "Sound"])).stderr, /already ended/u);

    const ended = await until(async () => (await messages()).find(message =>
      message.replyToMessageId === sent.messageId && message.body.startsWith("The program finished")), "the program's end");
    assert.equal(ended.body, "The program finished: no owner on failure");
    // The Run was started for that one request: once it has ended, its Machine is told to stop it.
    const stop = await daemon.inbox.waitFor(message => message.type === "machine_stop_agent" && message.runId === spawn.runId, "the holder's stop");
    assert.equal(stop.runId, spawn.runId);

    // A request of a person is a card that waits on them: found by name, answered by them alone, closed with its outcome.
    const asked = (await postChannelMessage(worker, MOCK_TOKEN, channelId, program(`switch confirm(@Norn, "Ship the release?", ~about="4.2")->wait {
| Answered(Yes) => "shipped"
| Answered(No) => "held"
| other => fail(other)
}`))).message;
    const card = await until(async () => (await messages()).find(message =>
      message.replyToMessageId === asked.messageId && message.messageResidual?.appMetadata?.nornRequest), "the request card");
    const request = card.messageResidual.appMetadata.nornRequest;
    assert.deepEqual([request.verb, request.holder, request.holderUserId, request.text, request.about, card.body.split("\n")[0]],
      ["confirm", "@Norn", ownerId, "Ship the release?", "4.2", "@Norn"]);
    // An Agent Run does not answer for a person, and an answer of the wrong kind is refused with the request left open.
    assert.ok([401, 403].includes((await answer(request.ref, { outcome: "answered", text: "Yes" }, runToken)).status));
    assert.match((await (await answer(request.ref, { outcome: "answered", text: "Maybe" })).json()).refusal, /Yes/u);
    assert.equal((await (await answer(request.ref, { outcome: "answered", text: "Yes" })).json()).status, "completed");
    assert.equal((await answer(request.ref, { outcome: "answered", text: "No" })).status, 404);
    const shipped = await until(async () => (await messages()).find(message =>
      message.replyToMessageId === asked.messageId && message.body.startsWith("The program finished")), "the program's end");
    assert.equal(shipped.body, "The program finished: shipped");
    const closed = await until(async () => (await messages()).find(message =>
      message.messageId === card.messageId && message.commandResult?.notes?.length), "the card's outcome");
    assert.equal(closed.commandResult.notes[0].text, "@Norn answered: Yes");

    // A name nobody here answers to ends the request at once, with the reason, and the program goes on from that.
    const nobody = (await postChannelMessage(worker, MOCK_TOKEN, channelId, program(`switch ask(@Nemo, "Anyone?")->wait {
| Broke(why) => why
| other => fail(other)
}`))).message;
    const unreached = await until(async () => (await messages()).find(message =>
      message.replyToMessageId === nobody.messageId && message.body.startsWith("The program finished")), "the unreachable request's end");
    assert.equal(unreached.body, "The program finished: Nobody named @Nemo can read this conversation");
  } finally {
    daemon?.ws.close();
    await worker.stop();
  }
});
