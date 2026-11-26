import assert from "node:assert/strict";
import test from "node:test";
import { nornFlow } from "../src/norn-plan.ts";
import { appStream, checkNornProgram, githubStream, guardRunningNornBlocks, nornActionAnswer, nornAnswerBody, nornAsking, nornBlocks, nornOutcomeText, nornPageEnd, nornPersonBody, nornQuestionSource, nornRequestCard, personHolder, nornDelivery, nornProgramIn, nornProgramProblems, nornStartLedger, nornStep, readNornAnswer } from "../src/norn-host.ts";

const review = `type verdict = Sound | Flawed(string)
let rec settle = draft =>
  switch run(@codex, "Find what does not hold", ~about=draft)->wait? {
  | Sound => Answered(draft)
  | Flawed(why) => settle(run(@claude, "Revise for these flaws", ~about=draft, ~context=why)->wait?)
  }
settle(run(@claude, "Draft the design")->wait?)`;
const fenced = (source, tag = "norn run") => `Please run this.\n\n\`\`\`${tag}\n${source}\n\`\`\`\n`;

/** A program's row as the database layer keeps it between steps. */
function program(source) {
  const state = { spaceId: "space", channelId: "channel", programId: "message", source, nowMs: 1_000, stopReason: null,
    ledger: nornStartLedger(1_000), requests: [] };
  return { state, step(answer, change = {}) {
    Object.assign(state, change);
    state.nowMs += 1_000;
    const { write, result } = nornStep(answer)(structuredClone(state));
    state.ledger = write.ledger;
    state.requests = write.requests.map(request => ({ ...request, deliveryMessageId: `norn:${request.requestRef}:${request.epoch}`,
      delivered: true, abandoned: false }));
    return { write, result, open: write.requests.filter(request => !request.settled) };
  } };
}

test("only a top-level block tagged norn run is a program", () => {
  assert.deepEqual(nornProgramIn(fenced(review)), { source: review });
  assert.equal(nornProgramIn(fenced(review, "norn")), undefined);
  assert.equal(nornProgramIn(`> \`\`\`norn run\n> ${review.split("\n")[0]}\n> \`\`\``), undefined);
  assert.match(nornProgramIn(fenced(review) + fenced(review)).refusal, /one program/u);
  assert.match(checkNornProgram(`run(@codex, "x")`).refusal, /^1:1 /u);
  // On a page a block may carry a name; without one it is `main`.
  assert.deepEqual(nornBlocks(`${fenced(review, "norn run review")}\n${fenced("1")}`),
    [{ name: "review", source: review }, { name: "main", source: "1" }]);
  // A name is a word in any language: it is what the program's conversation is called.
  assert.deepEqual(nornBlocks(fenced("1", "norn run 物业费")), [{ name: "物业费", source: "1" }]);
});

test("a block tagged norn run that runs nothing says why, wherever it is read", () => {
  const page = [fenced("1", "norn run 2nd"), fenced("2", "norn run two words"), fenced(review, "norn run twice"),
    fenced(review, "norn run twice"), fenced(review, "norn run fine")].join("\n");
  // Every block tagged norn run is one, so a page shows each, and none is passed over without a word.
  assert.deepEqual(nornBlocks(page).map(block => [block.name, Boolean(block.problem)]),
    [["2nd", true], ["two words", true], ["twice", true], ["twice", true], ["fine", false]]);
  // Whoever saved the page is told each, under the block's own opening line.
  assert.deepEqual(nornProgramProblems(page).map(problem => problem.source),
    ["```norn run 2nd", "```norn run two words", "```norn run twice", "```norn run twice"]);
  assert.match(nornProgramProblems(page)[0].problem, /names no program/u);
  assert.match(nornProgramProblems(page)[2].problem, /Two blocks are named twice/u);
  // A message's block is refused with the same words, not ignored.
  assert.match(nornProgramIn(fenced(review, "norn run 2nd")).refusal, /^The program was not started: `norn run 2nd` names no program/u);
  // Dual-header compatibility: `norn run review` and `norn 1 run review` share one identity,
  // and an unsupported edition keeps its name with a clear problem under its own opening line.
  assert.deepEqual(nornProgramIn(fenced(review, "norn 1 run")), { source: review });
  const mixed = [fenced(review, "norn run review"), fenced(review, "norn 1 run review")].join("\n");
  assert.deepEqual(nornProgramProblems(mixed).map(problem => problem.source), ["```norn run review", "```norn 1 run review"]);
  assert.match(nornProgramProblems(mixed)[0].problem, /Two blocks are named review/u);
  const future = nornProgramProblems(fenced(review, "norn 2 run review"));
  assert.equal(future.length, 1);
  assert.equal(future[0].source, "```norn 2 run review");
  assert.match(future[0].problem, /does not support yet/u);
});

test("two Agents review a design through typed requests, and the program reads each answer at once", () => {
  const { state, step } = program(review);
  const first = step();
  assert.deepEqual(first.open.map(request => request.holder), ["@claude"]);
  const draft = first.open[0];
  // Free text is the report of a run that asked for no form.
  assert.equal(step({ requestId: draft.requestId, epoch: draft.epoch, reply: { typed: "Ledger v1" } }).result.refusal, undefined);
  const [critique] = state.requests.filter(request => !request.settled);
  assert.equal(critique.holder, "@codex");
  // An answer outside the form the program reads is refused and settles nothing.
  const wrong = step({ requestId: critique.requestId, epoch: critique.epoch, reply: { typed: "Looks(\"fine\")" } });
  assert.match(wrong.result.refusal, /The report must be verdict/u);
  assert.equal(wrong.open.length, 1);
  step({ requestId: critique.requestId, epoch: critique.epoch, reply: { typed: `Flawed("no owner on failure")` } });
  const [revision] = state.requests.filter(request => !request.settled);
  assert.equal(revision.holder, "@claude");
  assert.equal(state.ledger.requests[revision.requestId].context, "no owner on failure");
  step({ requestId: revision.requestId, epoch: revision.epoch, reply: { typed: "Ledger v2" } });
  const [second] = state.requests.filter(request => !request.settled);
  const done = step({ requestId: second.requestId, epoch: second.epoch, reply: { typed: "Sound" } });
  assert.equal(done.result.status, "completed");
  assert.equal(state.ledger.ended.result.args[0].fields.text.value, "Ledger v2");
  // An answer after the end is told so, and changes nothing.
  assert.equal(nornStep({ requestId: second.requestId, epoch: second.epoch, reply: { typed: "Sound" } })(structuredClone(state)).result.refusal,
    "The request has already ended");
});

test("a request nobody works on any more is Broke, and the program goes on from that", () => {
  const { state, step } = program(`switch run(@codex, "Review")->wait { | Broke(why) => why | other => fail(other) }`);
  const [request] = step().open;
  state.requests[0].abandoned = true;
  const after = step();
  assert.equal(after.result.status, "completed");
  assert.match(state.ledger.ended.result.value, /ended without an answer/u);
  assert.equal(after.write.requests.find(row => row.requestId === request.requestId).settled, true);
});

test("work that broke off goes once to a new Instance, and the program is told only when that fails too", () => {
  const { state, step } = program(`switch run(@codex, "Review")->wait { | Broke(why) => why | other => fail(other) }`);
  const [request] = step().open;
  // The turn failed, or no Run ever took the request: not the Agent's own ending of it.
  Object.assign(state.requests[0], { abandoned: true, brokeOff: true });
  const again = step();
  assert.equal(again.result.status, "running");
  // The same request, held anew: its next delivery is another message, which starts another Run.
  assert.deepEqual(again.open.map(row => [row.requestId, row.requestRef, row.epoch]), [[request.requestId, request.requestRef, request.epoch + 1]]);
  assert.match(state.ledger.evidence[0].reason, /handed to a new Instance/u);
  // An answer from the holding that broke off settles nothing.
  assert.equal(step({ requestId: request.requestId, epoch: request.epoch, reply: { typed: "late" } }).result.refusal, "Not the request's holder");
  Object.assign(state.requests[0], { abandoned: true, brokeOff: true });
  assert.equal(step().result.status, "completed");
  assert.match(state.ledger.ended.result.value, /the second time on a new Instance/u);
});

test("a Page's program that ends tells people what they have not read, and one that failed waits on them", () => {
  const daniel = { userId: "u-daniel", name: "@Daniel" }, authority = { userId: "u-owner", name: "owner" };
  const { state, step } = program(`let answer = ask(@Daniel, "Delete the old builds?")->wait?
run(@claude, "Do what Daniel answered: " ++ answer)->wait`);
  const [card] = step().open;
  const [work] = step({ requestId: card.requestId, epoch: card.epoch, reply: { typed: "Yes, delete" } }).open;
  const page = () => nornPageEnd({ ended: state.ledger.ended, requests: state.ledger.requests, people: [daniel], authority });
  const failed = structuredClone(state);
  step({ requestId: work.requestId, epoch: work.epoch, reply: { typed: "Deleted 40 builds" } });
  // The Agent's answer stands in the conversation under its name: the end does not say it again.
  assert.deepEqual(page(), { body: "Finished.", waitsOn: [] });
  assert.equal(nornAnswerBody("answered", "Deleted 40 builds"), "Deleted 40 builds");
  assert.equal(nornAnswerBody("broke", "no access"), "I could not do this: no access");
  // The work failed: the person who answered is named and waited on, and reads where it stopped.
  Object.assign(state, failed);
  step({ requestId: work.requestId, epoch: work.epoch, reply: { tag: "Broke", reason: "its sign-in expired" } });
  assert.deepEqual(page(), { waitsOn: ["u-daniel"], body: "@Daniel This stopped before it was finished: claude, asked “Do what Daniel answered: Yes, delete”, " +
    "did not finish: its sign-in expired. Nothing more happens by itself: say here what to do next." });
  // A person who declined their own card ended it themselves: the end is plain, and waits on nobody.
  const declined = program(`ask(@Daniel, "Delete the old builds?")->wait`);
  const [asked] = declined.step().open;
  declined.step({ requestId: asked.requestId, epoch: asked.epoch, reply: { tag: "Refused", reason: "not now" } });
  assert.deepEqual(nornPageEnd({ ended: declined.state.ledger.ended, requests: declined.state.ledger.requests, people: [daniel], authority }),
    { body: "Ended without its result: Refused(not now)", waitsOn: [] });
  // With nobody who answered, whoever saved the program is told.
  assert.deepEqual(nornPageEnd({ ended: state.ledger.ended, requests: state.ledger.requests, people: [], authority }).waitsOn, ["u-owner"]);
  // A program taken off its page was ended by someone: nobody is waited on.
  assert.deepEqual(nornPageEnd({ ended: { at: 1, status: "failed", result: null, error: "Removed from its page" }, requests: {}, people: [daniel], authority }),
    { body: "Stopped: Removed from its page", waitsOn: [] });
  // A result that is not an Agent's answer is told, as its text.
  assert.equal(nornPageEnd({ ended: { at: 1, status: "completed", error: null, result: { type: "variant", name: "Answered", args: [{ type: "string", value: "42" }] } },
    requests: {}, people: [], authority }).body, "Finished: 42");
});

test("a stop in the conversation ends the program and cancels what it left open", () => {
  const { state, step } = program(`ask(@codex, "Ship it?")->wait`);
  step();
  const stopped = step(undefined, { stopReason: "Stopped in the conversation" });
  assert.deepEqual([stopped.result.status, state.ledger.ended.error, stopped.open.length], ["failed", "Stopped in the conversation", 0]);
});

test("a request this host cannot deliver ends at once, and one of a group goes to whom it can reach", () => {
  const instance = program(`switch ask(@codex:2, "Approve?")->wait { | Broke(why) => why | other => fail(other) }`);
  assert.equal(instance.step().result.status, "completed");
  assert.match(instance.state.ledger.ended.result.value, /cannot deliver a request to @codex:2/u);
  const group = program(`run(anyOf([@codex:2, @codex, @claude]), "Audit")->wait`);
  assert.deepEqual(group.step().open.map(request => [request.holder, request.epoch]), [["@codex", 1]]);
});

test("a program this build cannot check is left as it is and tried again, and can still be stopped", () => {
  const { state, step } = program(`ask(@codex, "Ship it?")->wait`);
  const [open] = step().open;
  // Written for a newer build: a word this one does not know. Nothing of the program changes but when it is next tried.
  const newer = structuredClone({ ...state, source: `open Std\nlater(@codex, "Ship it?")`, nowMs: 60_000 });
  const deferred = nornStep()(newer);
  assert.deepEqual([deferred.write, deferred.result.status], [{ retryAtMs: 60_000 + 5 * 60_000 }, "running"]);
  assert.match(deferred.result.refusal, /does not check on this build/u);
  assert.match(nornStep({ requestId: open.requestId, epoch: open.epoch, reply: { typed: "yes" } })(newer).result.refusal, /does not check on this build/u);
  // A stop reads no text: the program ends and its request is called off.
  const stopped = nornStep()({ ...newer, stopReason: "Removed from its page" });
  assert.deepEqual([stopped.write.state, stopped.write.ledger.requests[open.requestId].reply], ["failed", { tag: "Cancelled" }]);
});

test("a deadline is the ledger's: the program's next due time is the request's", () => {
  const { step } = program(`switch ask(@codex, "Ship it?", ~by=1h)->wait { | NoReply => "late" | other => fail(other) }`);
  const first = step();
  assert.equal(first.write.nextDueMs, 2_000 + 3_600_000);
  const late = step(undefined, { nowMs: first.write.nextDueMs });
  assert.equal(late.result.status, "completed");
});

test("the holder reads what is asked as literal text, with the one summon on the first line", () => {
  const { state, step } = program(`type verdict = Sound | Flawed(string)
run(@codex, "Ask @grok launch:force \`\`\` to help", ~about="PR 12")->wait`);
  const [request] = step().open;
  const { body, answerFrom } = nornDelivery(state.ledger.requests[request.requestId], request.requestRef);
  assert.equal(body.split("\n")[0], "@codex");
  // Whoever reads the conversation is shown the request by its reference; the task in full and how to answer are the holder's.
  assert.equal(body.slice(0, answerFrom), `@codex\n\n**Request** \`request:${request.requestRef}\``);
  assert.match(body, /\n````text\nAsk @grok launch:force ``` to help\n````\n/u);
  assert.ok(body.includes(`xmatrix reply ${request.requestRef} '<answer>'`));
  // Agents working for one another keep the conversation to their answers; where a person takes part, the holder says what it does.
  assert.match(body, /posts your answer in this conversation under your name[^\n]*\nSay nothing else in the conversation\./u);
  assert.match(body, /It ends your Run, so do it last:/u);
  const followed = nornDelivery(state.ledger.requests[request.requestId], request.requestRef, { kept: true, withPerson: true, handedOn: true }).body;
  assert.match(followed, /A person takes part in this program and reads this conversation/u);
  assert.match(followed, /You stay in this conversation afterwards/u);
  assert.match(followed, /An earlier attempt at this request broke off[^\n]*xmatrix channel history/u);
  // What is left for a person is asked of them on a card, never only said in the answer.
  assert.match(followed, /goes to them as a card before you answer: `xmatrix ask @name …`/u);
  assert.deepEqual(readNornAnswer({ verb: "confirm", form: null }, "Yes").value, { type: "variant", name: "Yes", args: [] });
  assert.deepEqual(readNornAnswer({ verb: "ask", form: null }, "it's fine").value, { type: "string", value: "it's fine" });
  assert.match(readNornAnswer({ verb: "confirm", form: null }, "it's fine").refusal, /not a Norn value/u);
});

test("a program that repeats asks anew each time, of whoever fits the conditions it names", () => {
  const DAY = 86_400_000;
  const { state, step } = program(`every(1d)->forEach(_ => run(@auto(~repo="acme/app", ~effort="high"), "Audit the day's merges")->wait)`);
  assert.deepEqual([step().open.length, state.ledger.ended], [0, null]);
  // The ticks keep the program's beat, a day apart, however long each round takes.
  for (const day of [1, 2, 3]) {
    const [request] = step(undefined, { nowMs: day * DAY }).open;
    assert.equal(nornDelivery(state.ledger.requests[request.requestId], request.requestRef).body.split("\n")[0],
      "@auto effort:high repo:acme/app");
    step({ requestId: request.requestId, epoch: request.epoch, reply: { typed: "nothing to fix" } }, { nowMs: day * DAY + 7_200_000 });
  }
  assert.equal(Object.keys(state.ledger.requests).length, 3);
  // The task reworded on its Page: the rounds behind it are not asked again, and the next beat asks in the new words.
  state.source = state.source.replace("Audit the day's merges", "Audit the day's merges and the changelog");
  assert.equal(step(undefined, { nowMs: 3 * DAY + 7_300_000 }).open.length, 0);
  const [reworded] = step(undefined, { nowMs: 4 * DAY }).open;
  assert.deepEqual([state.ledger.requests[reworded.requestId].text, Object.keys(state.ledger.requests).length],
    ["Audit the day's merges and the changelog", 4]);
  // Reworded while that round is out: the round is asked in the new words, and the request in the old words is called off.
  state.source = state.source.replace("and the changelog", "and the release notes");
  const again = step(undefined, { nowMs: 4 * DAY + 60_000 });
  assert.deepEqual(again.open.map(request => state.ledger.requests[request.requestId].text), ["Audit the day's merges and the release notes"]);
  assert.deepEqual(state.ledger.requests[reworded.requestId].reply, { tag: "Cancelled" });
  // A round that ends in anything but an answer is told in the program's conversation, once, and the loop goes on.
  const [failing] = step(undefined, { nowMs: 4 * DAY + 120_000 }).open;
  const told = step({ requestId: failing.requestId, epoch: failing.epoch, reply: { tag: "Refused", reason: "no quota today" } }, { nowMs: 5 * DAY + 60_000 });
  assert.deepEqual(told.write.notices.map(notice => [notice.recipient, notice.body]), [["", "A round of this program did not succeed: Refused(no quota today)"]]);
  assert.deepEqual([step(undefined, { nowMs: 5 * DAY + 120_000 }).write.notices, state.ledger.ended], [[], null]);
  // A beat counted from a time: the first round is at that time, not a period after the program started.
  const weekly = program(`every(7d, ~from=1970-01-03T00:00Z)->forEach(_ => run(@auto, "Weekly round")->wait)`);
  assert.equal(weekly.step().write.nextDueMs, 2 * DAY);
  assert.equal(weekly.step(undefined, { nowMs: 2 * DAY }).open.length, 1);
  // A condition this host cannot write into a summon ends the request with the reason, not with a silent default.
  const unknown = program(`switch run(@auto(~mood="calm"), "Audit")->wait { | Broke(why) => why | other => fail(other) }`);
  assert.equal(unknown.step().result.status, "completed");
  assert.match(unknown.state.ledger.ended.result.value, /does not know the condition ~mood/u);
});

test("what a program says is handed over once, in the step that says it", () => {
  const { step } = program(`say(@daniel, "The flight leaves at 12:15")
ask(@codex, "Anything else?")->wait`);
  assert.deepEqual(step().write.notices.map(({ recipient, body }) => [recipient, body]), [["@daniel", "The flight leaves at 12:15"]]);
  assert.deepEqual(step().write.notices, []);
});

test("a program waits for an outside event beside its beat, and an event it hears starts a round at once", () => {
  const { state, step } = program(`every(1d)->or(ciFailed("acme/app"))->forEach(_ => run(@auto(~repo="acme/app"), "Check production")->wait)`);
  const first = step();
  assert.deepEqual(first.write.waits.map(stream => [stream.name, stream.args[0].value]), [["ciFailed", "acme/app"]]);
  assert.equal(first.open.length, 0);
  const heard = nornStep(undefined, { id: "ci-1", streams: first.write.waits, what: "Workflow CI failed on main" })(
    structuredClone({ ...state, nowMs: state.nowMs + 60_000 }));
  assert.deepEqual(heard.write.requests.map(request => request.holder), ["@auto"]);
  // While the round runs the program still listens: two more failures are kept, and are one more round with the latest.
  assert.deepEqual(heard.write.waits.map(stream => stream.name), ["ciFailed"]);
  const during = { ...state, ledger: heard.write.ledger, requests: [] };
  for (const [what, at] of [["Deploy failed", 120_000], ["Tests failed again", 180_000]]) {
    during.ledger = nornStep(undefined, { id: `ci-${at}`, streams: heard.write.waits, what })(
      structuredClone({ ...during, nowMs: state.nowMs + at })).write.ledger;
  }
  assert.equal(Object.keys(during.ledger.requests).length, 1);
  const [running] = Object.values(during.ledger.requests);
  const after = nornStep({ requestId: running.id, epoch: running.epoch, reply: { typed: "fixed" } })(structuredClone({ ...during, nowMs: state.nowMs + 240_000,
    requests: [{ requestId: running.id, requestRef: "rsecond2345", epoch: running.epoch, holder: running.holder, deliveryMessageId: "d", delivered: true, settled: false, abandoned: false }] })).write;
  assert.deepEqual(Object.values(after.ledger.requests).map(request => [request.text, request.reply?.tag ?? "open"]),
    [["Check production", "Answered"], ["Check production", "open"]]);
  assert.match(checkNornProgram(`appEvent("sentry", ~feature="issue.created")->forEach(what => ask(@auto, what)->wait)`).targets.join(","), /@auto/u);
  // Several repositories and the beat read as one stream of text: `map` brings each to the same shape.
  const many = program(`let both = (a, b) => a->or(b)->map(each => switch each { | First(what) => what | Second(what) => what })
both(every(1d)->map(_ => "the daily round"), both(ciFailed("acme/app"), ciFailed("acme/web")))->forEach(why => ask(@auto, why)->wait)`);
  const listening = many.step().write;
  assert.deepEqual(listening.waits.map(stream => stream.args[0].value), ["acme/app", "acme/web"]);
  const round = nornStep(undefined, { id: "deploy-1", streams: [listening.waits[1]], what: "Deploy failed" })(
    structuredClone({ ...many.state, nowMs: many.state.nowMs + 1 })).write;
  assert.deepEqual(Object.values(round.ledger.requests).map(request => request.text), ["Deploy failed"]);
  // An event is an occurrence of the streams that name its source: the repository, or the app and — when named — its feature.
  const waits = source => program(source).step().write.waits;
  const [ci] = waits(`ciFailed("acme/app")->forEach(what => ask(@auto, what)->wait)`);
  assert.deepEqual([githubStream("ci-failed", "acme/app")(ci), githubStream("merged", "acme/app")(ci), githubStream("ci-failed", "acme/web")(ci)],
    [true, false, false]);
  const [issue] = waits(`appEvent("sentry", ~feature="issue.created")->forEach(what => ask(@auto, what)->wait)`);
  const [any] = waits(`appEvent("sentry")->forEach(what => ask(@auto, what)->wait)`);
  assert.deepEqual([appStream("sentry", "issue.created")(issue), appStream("sentry", "issue.resolved")(issue),
    appStream("sentry", "issue.resolved")(any), appStream("stripe", "issue.created")(any)], [true, false, true, false]);
});

test("an outside event is recorded for every matching stream once, even when this build cannot evaluate", () => {
  const source = 'appEvent("sentry")->or(appEvent("sentry", ~feature="issue.created"))->forEach(what => ask(@codex, show(what))->wait)';
  const { state, step } = program(source);
  const { waits } = step().write;
  assert.equal(waits.length, 2);
  const event = { id: "sentry-event-1", streams: waits, what: "Issue created" };
  const retry = nornStep(undefined, event)({ ...structuredClone(state), source: "(", nowMs: state.nowMs + 1 });
  assert.equal(retry.write.ledger.occurrences.length, 2);
  assert.ok(retry.write.retryAtMs > state.nowMs);
  const resumed = { ...state, ledger: retry.write.ledger, nowMs: retry.write.retryAtMs };
  assert.equal(nornStep(undefined, event)(structuredClone(resumed)).write, null);
  const evaluated = nornStep()(structuredClone(resumed)).write;
  assert.deepEqual(evaluated.requests.map(request => request.holder), ["@codex"]);
  const distinct = nornStep(undefined, { ...event, id: "sentry-event-2" })({ ...resumed, ledger: evaluated.ledger }).write;
  assert.equal(distinct.ledger.occurrences.length, 4);
});

test("a request of a person stays open for them, and reads as a card with what an answer may be", () => {
  assert.deepEqual(["@Daniel", "@claude", "@auto", "@claude:2"].map(personHolder), [true, false, false, false]);
  const { state, step } = program(`type risk = Low | High(string)
switch choose(@Daniel, "How risky is this release?", [Low, High("say why")], ~by=2h, ~about="4.2")->wait {
| Answered(Low) => "ship"
| Answered(High(why)) => why
| NoReply => "nobody decided"
| other => fail(other)
}`);
  const [open] = step().open;
  assert.equal(open.holder, "@Daniel");
  const asked = state.ledger.requests[open.requestId];
  const card = nornRequestCard(asked, open.requestRef, "user-1");
  assert.deepEqual([card.verb, card.holderUserId, card.options, card.about, card.by], ["choose", "user-1", ["Low", "High(say why)"], "4.2",
    new Date(asked.by).toISOString()]);
  const body = nornPersonBody(asked).split("\n");
  // What is asked leads the message: it is what a list of conversations shows of it.
  assert.deepEqual([body[0], body.at(-1)], ["@Daniel How risky is this release?",
    `Answer on this card: one of: Low, High(say why). It closes at ${card.by}. A program asks.`]);
  assert.doesNotMatch(body.join("\n"), new RegExp(open.requestRef, "u"));
  const long = program(`ask(@Daniel, "Pay the **fee**?\\nTwo invoices disagree.")->wait`);
  const [asked2] = long.step().open;
  assert.deepEqual(nornPersonBody(long.state.ledger.requests[asked2.requestId]).split("\n").slice(0, 3),
    ["@Daniel Pay the fee?", "", "```text"]);
  // A person's request is not an Agent's: conditions on where to run do not apply, and silence is not an answer.
  const conditioned = program(`switch ask(@Daniel(~repo="acme/app"), "Which?")->wait { | Broke(why) => why | other => fail(other) }`);
  conditioned.step();
  assert.match(conditioned.state.ledger.ended.result.value, /is a person/u);
  step(undefined, { nowMs: state.nowMs + 3 * 3_600_000 });
  assert.equal(state.ledger.ended.result.value, "nobody decided");
  assert.deepEqual([nornOutcomeText("@Daniel", { tag: "Answered", value: { type: "variant", name: "Low", args: [] } }),
    nornOutcomeText("@Daniel", { tag: "Refused", reason: "not mine" }), nornOutcomeText("@Daniel", { tag: "NoReply" })],
    ["@Daniel answered: Low", "@Daniel declined: not mine", "It closed without an answer."]);
});

test("a person who cannot judge a request delegates it to an Agent here, and the program reads that answer as any", () => {
  const { state, step } = program(`switch confirm(@Daniel, "Clean up the expired commands?", ~by=2d)->wait {
| Answered(Yes) => "clean"
| Answered(No) | NoReply => "keep"
| other => fail(other)
}`);
  const [asked] = step().open;
  // An Instance here by its address holds a request only when its holder delegated it there; a program that
  // names one itself is still not delivered (see "a request this host cannot deliver ends at once").
  const delegated = step({ requestId: asked.requestId, epoch: asked.epoch, delegateTo: "@claude:2", reason: "I cannot judge this" });
  assert.equal(delegated.result.refusal, undefined);
  assert.deepEqual(delegated.open.map(row => [row.holder, row.epoch, row.delegated]), [["@claude:2", asked.epoch + 1, true]]);
  // The delegate is told for whom it answers, in their quoted words, and that a refusal gives it back.
  const request = state.ledger.requests[asked.requestId];
  const delivery = nornDelivery(request, asked.requestRef, { there: "@claude:2", delegation: state.ledger.delegations.at(-1) }).body;
  assert.match(delivery, /Daniel delegated this request to you: you answer it for them\.\nTheir words:\n```text\nI cannot judge this\n```/u);
  assert.match(delivery, /gives it back to Daniel; it does not end the request/u);
  assert.doesNotMatch(delivery, /xmatrix delegate/u);
  // An Instance that was at work here before it was delegated the request is not told that answering ends its Run.
  const atWork = nornDelivery(request, asked.requestRef, { there: "@claude:2", atWork: true, delegation: state.ledger.delegations.at(-1) }).body;
  assert.match(atWork, /It does not end your Run: you were at work here before it came, and you go on:/u);
  assert.doesNotMatch(atWork, /It ends your Run/u);
  // The delegator's own answer no longer counts; the delegate's settles the request.
  assert.equal(step({ requestId: asked.requestId, epoch: asked.epoch, reply: { typed: "No" } }).result.refusal, "Not the request's holder");
  assert.equal(step({ requestId: asked.requestId, epoch: asked.epoch + 1, reply: { typed: "Yes" } }).result.status, "completed");
  assert.equal(state.ledger.ended.result.value, "clean");
  assert.deepEqual([request.holder, state.ledger.requests[asked.requestId].delegatedBy], ["@claude:2", "@Daniel"]);
});

test("a delegate who will not answer gives the request back to whoever delegated it, and nothing ends", () => {
  const { state, step } = program(`confirm(@Daniel, "Clean up?")->wait`);
  const [asked] = step().open;
  step({ requestId: asked.requestId, epoch: asked.epoch, delegateTo: "@Bob", reason: "Yours to judge" });
  // A person delegated to reads on their card who delegated it, and that declining gives it back.
  const held = state.ledger.requests[asked.requestId];
  assert.equal(nornRequestCard(held, asked.requestRef, "user-bob").delegatedBy, "@Daniel");
  assert.match(nornPersonBody(held, undefined, state.ledger.delegations.at(-1)),
    /^@Bob Clean up\?\n\nDaniel delegated this request to you: you answer it for them\.\nTheir words:\n```text\nYours to judge\n```\nDeclining gives it back to Daniel\./u);
  const why = "Production data is not mine to judge";
  const back = step({ requestId: asked.requestId, epoch: asked.epoch + 1, reply: { tag: "Refused", reason: why } });
  // Not a refusal of the request: the program is still waiting, and the request is the delegator's again.
  assert.deepEqual([back.result.status, back.result.refusal, back.result.returnedTo], ["running", undefined, "@Daniel"]);
  assert.deepEqual(back.open.map(row => [row.holder, row.epoch, row.delegated]), [["@Daniel", asked.epoch + 2, false]]);
  assert.equal(nornAnswerBody("refused", why, back.result.returnedTo), `I gave this back to Daniel: ${why}`);
  // Their new card says who gave it back and why.
  assert.match(nornPersonBody(state.ledger.requests[asked.requestId], undefined, state.ledger.delegations.at(-1)),
    /Bob, to whom you delegated this request, gave it back: it is yours to answer again\.\nTheir words:/u);
  // Whom the program asked is offered delegation in its delivery; a delegate is not (see above).
  const agent = program(`run(@codex, "Review")->wait`);
  const [run] = agent.step().open;
  assert.match(nornDelivery(agent.state.ledger.requests[run.requestId], run.requestRef).body,
    new RegExp(`xmatrix delegate ${run.requestRef} @name '<why>'`, "u"));
});

test("a request is delegated only where this host can deliver it, once, and the delegator can take it back", () => {
  const { state, step } = program(`run(@auto(~repo="acme/app"), "Fix the flaky test")->wait`);
  const [asked] = step().open;
  const delegate = (to, epoch = asked.epoch) => step({ requestId: asked.requestId, epoch, delegateTo: to }).result.refusal;
  // Conditions on where to run are an Agent's to meet; a group is not one participant.
  assert.match(delegate("@Daniel"), /is a person: the request's conditions, such as ~repo, apply to an Agent/u);
  assert.match(delegate("anyOf"), /cannot deliver a request to anyOf/u);
  assert.equal(delegate("@codex"), undefined);
  assert.equal(delegate("@claude", asked.epoch + 1), "A delegate answers the request or gives it back; they cannot delegate it again");
  const back = step({ requestId: asked.requestId, reclaim: true });
  assert.deepEqual([back.result.refusal, back.open.map(row => [row.holder, row.epoch, row.delegated])], [undefined, [["@auto", asked.epoch + 2, false]]]);
  assert.equal(step({ requestId: asked.requestId, reclaim: true }).result.refusal, "The request is not delegated");
  assert.equal(state.ledger.requests[asked.requestId].conditions.repo, "acme/app");
});

test("a question asked with a command is its program: the request, waited on, with what silence means", () => {
  assert.deepEqual(nornQuestionSource({ verb: "ask", who: "@Daniel", question: 'Which "address"?\nThe billing one.' }),
    { source: 'ask(@Daniel, "Which \\"address\\"?\\nThe billing one.")->wait' });
  assert.deepEqual(nornQuestionSource({ verb: "choose", who: "@Daniel", question: "Which?", options: ["Approve", "Reject"], by: "2d", otherwise: "Reject" }),
    { source: "type choice = Approve | Reject\nswitch choose(@Daniel, \"Which?\", [Approve, Reject], ~by=2d)->wait {\n| NoReply => Answered(Reject)\n| other => other\n}" });
  // The program it writes runs: asked, unanswered at its time, it ends with the answer the asker gave for silence.
  const built = nornQuestionSource({ verb: "confirm", who: "@Daniel", question: "Ship?", by: "1h", otherwise: "No" });
  const asked = program(built.source);
  assert.equal(asked.step().open.length, 1);
  asked.step(undefined, { nowMs: asked.state.nowMs + 2 * 3_600_000 });
  assert.deepEqual([asked.state.ledger.ended.result.name, asked.state.ledger.ended.result.args[0].name], ["Answered", "No"]);
  for (const [input, why] of [[{ verb: "ask", who: "Daniel", question: "?" }, /Name whom to ask/u],
    [{ verb: "choose", who: "@Daniel", question: "?", options: ["yes", "no"] }, /capitalised word/u],
    [{ verb: "choose", who: "@Daniel", question: "?", options: ["Go", "Go"] }, /different options/u],
    [{ verb: "confirm", who: "@Daniel", question: "?", by: "soon" }, /--by is a duration/u],
    [{ verb: "confirm", who: "@Daniel", question: "?", otherwise: "Yes" }, /needs --by/u],
    [{ verb: "confirm", who: "@Daniel", question: "?", by: "1d", otherwise: "Maybe" }, /one of Yes, No/u]]) {
    assert.match(nornQuestionSource(input).refusal, why);
  }
});

test("a question asked with a command reads on its card: the Agent that asks, and what silence means", () => {
  const { source } = nornQuestionSource({ verb: "choose", who: "@Daniel", question: "Drop the tables?", options: ["DropTables", "KeepTables"],
    by: "1d", otherwise: "KeepTables" });
  const asking = nornAsking({ authorMention: "@claude:2", source, askedWithCommand: true });
  assert.deepEqual(asking, { asker: "claude:2", otherwise: "KeepTables" });
  // A program someone wrote says what silence means in its own words: only the command's program is read for it.
  assert.deepEqual(nornAsking({ authorMention: null, source, askedWithCommand: false }), { asker: null, otherwise: null });
  const asked = program(source);
  const [open] = asked.step().open;
  const request = asked.state.ledger.requests[open.requestId];
  assert.deepEqual([nornRequestCard(request, open.requestRef, "user-1", asking).asker, nornRequestCard(request, open.requestRef, "user-1", asking).otherwise],
    ["claude:2", "KeepTables"]);
  assert.match(nornPersonBody(request, asking).split("\n").at(-1), /; without an answer, KeepTables\. claude:2 asks\.$/u);
  assert.equal(nornOutcomeText("@Daniel", { tag: "NoReply" }, asking.otherwise), "It closed without an answer, so KeepTables.");
});

test("a program opens the standard library: a routine is one line, and a decision has its default", () => {
  const DAY = 86_400_000;
  const upkeep = program(`open Std
routine(~every=7d, ~from=1970-01-03T00:00Z, ~who=@auto(~repo="acme/app"), ~otherwise=@claude(~repo="acme/app"), "Weekly upkeep")`);
  assert.equal(upkeep.step().write.nextDueMs, 2 * DAY);
  const [first] = upkeep.step(undefined, { nowMs: 2 * DAY }).open;
  assert.equal(nornDelivery(upkeep.state.ledger.requests[first.requestId], first.requestRef).body.split("\n")[0], "@auto repo:acme/app");
  // The first did not answer: the same round goes once to the one named to fall back on.
  const [second] = upkeep.step({ requestId: first.requestId, epoch: first.epoch, reply: { tag: "Broke", reason: "no machine" } }, { nowMs: 2 * DAY + 60_000 }).open;
  assert.equal(second.holder, "@claude");
  upkeep.step({ requestId: second.requestId, epoch: second.epoch, reply: { typed: "done" } }, { nowMs: 2 * DAY + 120_000 });
  assert.deepEqual([upkeep.state.ledger.ended, upkeep.step().write.nextDueMs], [null, 9 * DAY]);
  const decision = program(`open Std
type plan = Monthly | Yearly
decide(@Daniel, "Which billing plan?", ~options=[Monthly, Yearly], ~recommend=Yearly, ~by=2d)`);
  const [asked] = decision.step().open;
  assert.match(decision.state.ledger.requests[asked.requestId].text, /^Which billing plan\?\nRecommended: Yearly\./u);
  decision.step(undefined, { nowMs: decision.state.nowMs + 3 * DAY });
  assert.equal(decision.state.ledger.ended.result.name, "Yearly");
  // A word the library does not have is refused where the program is written.
  assert.match(checkNornProgram(`open Std\nreminder(@Daniel, "x", ~at=1h)`).refusal, /reminder/u);
});

/** The flow a program is drawn as, read at `now` from the ledger its row holds. */
const flowOf = (source, ledger, now = Date.parse("2026-11-13T18:00:00Z")) => nornFlow(checkNornProgram(source).code, ledger ?? nornStartLedger(now), now);
/** A flow as one line a step, a branch indented under the request it leaves. */
const outline = (steps, indent = "") => steps.flatMap(step => {
  if (step.kind === "wait") return [`${indent}wait ${[step.at, ...step.on, step.repeats ? `repeats ${step.every}` : ""].filter(Boolean).join(" | ")}`];
  if (step.kind === "ask") return [`${indent}${step.verb} ${step.holder}${step.open ? " (open)" : ""}: ${step.text}`,
    ...step.otherwise.flatMap(way => [`${indent}  [${way.when}]`, ...outline(way.steps, `${indent}    `)]), ...(step.main ? [`${indent}[${step.main}]`] : [])];
  if (step.kind === "say") return [`${indent}say ${step.to}: ${step.text}`];
  if (step.kind === "end") return [`${indent}${step.failed ? "stop" : "end"} ${step.result}`.trimEnd()];
  return [`${indent}${step.kind}${step.text ? ` ${step.text}` : ""}`];
});

test("a program's flow is read off the program: the time it waits for, whom it asks, and who is asked when that fails", () => {
  const source = `let task = "Check the price snapshots are gone"
after(2026-11-17T02:00:00Z)->wait
switch run(@auto(~repo="acme/router"), task, ~by=8h)->wait {
| Answered(report) => Answered(report)
| _ => run(@claude(~repo="acme/router"), task, ~by=8h)->wait
}`;
  const flow = flowOf(source);
  assert.deepEqual(outline(flow), [
    "wait 2026-11-17T02:00:00.000Z",
    "run @auto: Check the price snapshots are gone",
    "  [otherwise]",
    "    run @claude: Check the price snapshots are gone",
    "      [otherwise]",
    "        stop",
    "    [answered]",
    "    end the answer",
    "[answered]",
    "end the answer",
  ]);
  // What is asked of whoever takes it, and how long they have, come with the request.
  assert.deepEqual([flow[1].conditions, flow[1].within, flow[1].open], [{ repo: "acme/router" }, 8 * 3_600_000, false]);
});

test("a routine's flow is one round and the way back: the beat it keeps, what else starts a round, and a failed round told", () => {
  const source = `open Std
routine(~every=1d, ~from=2026-11-14T09:00Z, ~on=ciFailed("acme/app"), ~who=@auto(~repo="acme/app"), ~otherwise=@claude(~repo="acme/app"), "Daily upkeep")`;
  assert.deepEqual(outline(flowOf(source)), [
    "wait 2026-11-14T09:00:00.000Z | CI fails on acme/app | repeats 86400000",
    "run @auto: Daily upkeep",
    "  [otherwise]",
    "    run @claude: Daily upkeep",
    "      [otherwise]",
    "        say : This round did not succeed.",
    "        again",
    "    [answered]",
    "    again",
    "[answered]",
    "again",
  ]);
  // Mid-round the flow begins with the request that is out, then shows the round that repeats.
  const { state, step } = program(source);
  step();
  step(undefined, { nowMs: Date.parse("2026-11-14T09:00:00Z") });
  assert.deepEqual(outline(flowOf(source, state.ledger, Date.parse("2026-11-14T09:05:00Z"))).filter(line => !line.startsWith(" ")), [
    "run @auto (open): Daily upkeep", "[answered]",
    "wait 2026-11-15T09:00:00.000Z | CI fails on acme/app | repeats 86400000", "run @auto: Daily upkeep", "[answered]", "again"]);
});

test("a flow branches on each answer a request can get, and a function that calls itself goes back to where it asked before", () => {
  assert.deepEqual(outline(flowOf(`switch confirm(@Daniel, "Ship 4.2?", ~by=1d)->wait {
| Answered(Yes) => say(@Daniel, "Shipping")
| _ => say(@Daniel, "Held")
}`)), ["confirm @Daniel: Ship 4.2?", "  [No, otherwise]", "    say @Daniel: Held", "    end", "[Yes]", "say @Daniel: Shipping", "end"]);
  assert.deepEqual(outline(flowOf(review)), [
    "run @claude: Draft the design",
    "  [otherwise]",
    "    stop",
    "[answered]",
    "run @codex: Find what does not hold",
    "  [Flawed]",
    "    run @claude: Revise for these flaws",
    "      [otherwise]",
    "        stop",
    "    [answered]",
    "    again Find what does not hold",
    "  [otherwise]",
    "    stop",
    "[Sound]",
    "end the answer",
  ]);
  // The same wait written twice in a row is two steps, not a round that repeats.
  assert.deepEqual(outline(flowOf(`after(1d)->wait\nsay(@Daniel, "one")\nafter(1d)->wait\nsay(@Daniel, "two")`)),
    ["wait 2026-11-14T18:00:00.000Z", "say @Daniel: one", "wait 2026-11-15T18:00:00.000Z", "say @Daniel: two", "end"]);
});

test("reading a program's flow changes nothing, and a program that has ended has none", () => {
  const { state, step } = program(`run(@codex, "Reply with ok")->wait`);
  const [asked] = step().open;
  const before = JSON.stringify(state.ledger);
  assert.deepEqual(outline(flowOf(state.source, state.ledger, 5_000)), ["run @codex (open): Reply with ok", "  [otherwise]", "    stop", "[answered]", "end the answer"]);
  assert.equal(JSON.stringify(state.ledger), before);
  step({ requestId: asked.requestId, epoch: asked.epoch, reply: { typed: "ok" } });
  assert.deepEqual(flowOf(state.source, state.ledger, 9_000), []);
});

// A connected app's request is the host's own (Norn spec §6.3): these own what a program's pass makes of it and
// what the host answers it with. The connector's approval and execution are owned by the connector tests.
const publishing = `switch X.prepareVideo("@acme", "message-1/video-1", "Stop pasting API keys.")->wait {
| Answered(ready) =>
  after(1d)->wait
  switch X.publish(ready)->wait {
  | Answered(posted) => posted.summary
  | Refused(why) => \`not posted: \${why}\`
  | other => fail(other)
  }
| Refused(why) => \`declined: \${why}\`
| other => fail(other)
}`;

test("a program asks a connected app: admitted ahead, done at its time, and never asked twice", async () => {
  const { nornActionAnswer, nornPreparedReply, nornRequestWords } = await import("../src/norn-host.ts");
  const { nornActionStatement } = await import("../src/norn-libraries.ts");
  const { state, step } = program(publishing);
  const [prepare] = step().open;
  assert.equal(prepare.holder, "app:x");
  const asked = state.ledger.requests[prepare.requestId];
  assert.equal(asked.verb, "prepare");
  assert.deepEqual([asked.action.app, asked.action.name, asked.action.prepared], ["x", "publish_video", null]);
  // The program's typed input stands for the command a person or an Agent would have written.
  assert.deepEqual(nornActionStatement("x", "publish_video", asked.action.input),
    { target: "@acme", text: JSON.stringify({ text: "Stop pasting API keys.", video: "message-1/video-1" }) });
  assert.deepEqual(nornRequestWords(asked), { holder: "@X",
    text: "Approve publish_video: {account: @acme, text: Stop pasting API keys., video: message-1/video-1}" });

  // Admitted: the program waits for its time, and nothing is asked of the app meanwhile.
  const waiting = step({ requestId: prepare.requestId, epoch: 0, reply: nornPreparedReply(asked) });
  assert.equal(waiting.result.refusal, undefined);
  assert.deepEqual(waiting.open, []);
  assert.equal(waiting.write.nextDueMs, state.ledger.requests[prepare.requestId].settledAt + 86_400_000);

  const [perform, ...more] = step(undefined, { nowMs: waiting.write.nextDueMs }).open;
  assert.deepEqual(more, []);
  const doing = state.ledger.requests[perform.requestId];
  assert.deepEqual([doing.verb, doing.holder, doing.action.prepared], ["perform", "app:x", prepare.requestId]);
  assert.deepEqual(nornRequestWords(doing), { holder: "@X", text: "Do publish_video, as approved" });
  // Passes while the app is at work open nothing more.
  assert.equal(step().open.length, 1);
  assert.equal(Object.keys(state.ledger.requests).length, 2);

  const done = step({ requestId: perform.requestId, epoch: 0,
    reply: nornActionAnswer({ summary: "Posted with video as @acme: 909", url: "https://x.com/acme/status/909" }) });
  assert.equal(done.result.status, "completed");
  assert.equal(state.ledger.ended.result.value, "Posted with video as @acme: 909");
});

test("an action a Space admin declines, or that can no longer run, is a reply the program reads", async () => {
  const { nornPreparedReply } = await import("../src/norn-host.ts");
  const declined = program(publishing);
  const [prepare] = declined.step().open;
  declined.step({ requestId: prepare.requestId, epoch: 0, reply: { tag: "Refused", reason: "A Space admin declined it" } });
  assert.equal(declined.state.ledger.ended.result.value, "declined: A Space admin declined it");

  // Only the request's own token admits it: a made-up one settles nothing.
  const forged = program(publishing);
  const [asked] = forged.step().open;
  const refused = forged.step({ requestId: asked.requestId, epoch: 0, reply: { tag: "Answered", value: { type: "variant", name: "Prepared", args: [{ type: "string", value: "request:other" }] } } });
  assert.match(refused.result.refusal, /prepared action/u);
  assert.equal(refused.open.length, 1);

  const stale = program(publishing);
  const [first] = stale.step().open;
  const waiting = stale.step({ requestId: first.requestId, epoch: 0, reply: nornPreparedReply(stale.state.ledger.requests[first.requestId]) });
  const [perform] = stale.step(undefined, { nowMs: waiting.write.nextDueMs }).open;
  stale.step({ requestId: perform.requestId, epoch: 0, reply: { tag: "Refused", reason: "The connected account changed" } });
  assert.equal(stale.state.ledger.ended.result.value, "not posted: The connected account changed");

  // Connector permission revocation ends ONLY that single request as `Revoked` so the program can handle it and continue.
  const recoverable = program(`let outcome = switch X.preparePost("@acme", "Hello")->wait {
| Answered(_) => "ready"
| Revoked => "needs-reconnect"
| other => fail(other)
}
say(@Daniel, outcome)
outcome`);
  const [req] = recoverable.step().open;
  const afterRevoked = recoverable.step({ requestId: req.requestId, epoch: 0, reply: { tag: "Revoked" } });
  assert.equal(afterRevoked.result.status, "completed");
  assert.equal(recoverable.state.ledger.ended.result.value, "needs-reconnect");
  assert.deepEqual(afterRevoked.write.notices.map(n => n.body), ["needs-reconnect"]);
});

test("the host gives up on an app's request it never heard about, in words for each half", async () => {
  const { nornPreparedReply } = await import("../src/norn-host.ts");
  const unanswered = program(`switch X.preparePost("@acme", "Hello")->wait { | Broke(why) => why | other => fail(other) }`);
  unanswered.step();
  unanswered.state.requests[0].abandoned = true;
  unanswered.step();
  assert.equal(unanswered.state.ledger.ended.result.value, "Nobody answered this approval request in 30 days");

  const lost = program(`let ready = X.preparePost("@acme", "Hello")->wait?
switch X.publish(ready)->wait { | Broke(why) => why | other => fail(other) }`);
  const [prepare] = lost.step().open;
  const [perform] = lost.step({ requestId: prepare.requestId, epoch: 0, reply: nornPreparedReply(lost.state.ledger.requests[prepare.requestId]) }).open;
  lost.state.requests.find(row => row.requestId === perform.requestId).abandoned = true;
  // It is not handed to anyone else, as an Agent's broken-off work is: an action is never tried twice.
  lost.state.requests.find(row => row.requestId === perform.requestId).brokeOff = true;
  lost.step();
  assert.equal(lost.state.ledger.ended.result.value, "The action stopped without a confirmed result; it was not tried again");
});

test("a program is checked against what each connected app can do", () => {
  const refusal = source => checkNornProgram(source).refusal ?? "";
  assert.match(refusal(`let a = Actions.action("x", "pubish_video")\nignore(a)`), /no action "pubish_video".*did you mean "publish_video"/u);
  assert.match(refusal(`let a = Actions.action("nope", "post")\nignore(a)`), /unknown connector app "nope"/u);
  assert.match(refusal(`type post = {account: string}\ntype posted = {summary: string}
let a: Actions.action<post, posted> = Actions.action("x", "post")\nignore(a)`), /requires the field text/u);
  assert.match(refusal(`let a = Actions.action("github", "merge")\nignore(a)`), /connector "github" has no action "merge"/u);
  // Every write an app declares can be asked for, as the command writes it: a target and a text.
  assert.equal(refusal(`type command = {target: string, text: string}\ntype done = {summary: string, url: option<string>}
let send: Actions.action<command, done> = Actions.action("slack", "post")
let ready = Actions.prepare(send, {target: "#general", text: "Shipped."})->wait?
Actions.perform(ready)->wait`), "");
  // Declared read actions can be called via Actions.read with structured JSON outputs; write actions cannot.
  const readQuery = `type query = {target: string, text: string}
type dbAnswer = {summary: string, url: option<string>, rows: json}
let q: Actions.action<query, dbAnswer> = Actions.action("cloudflare", "query_database")
switch Actions.read(q, {target: "trace-db", text: "SELECT 1"})->wait {
| Answered(r) => switch JSON.asList(r.rows) { | Some(rows) => if List.length(rows) > 0 { "some" } else { "none" } | None => "none" }
| Revoked => "revoked"
| other => "other"
}`;
  assert.equal(refusal(readQuery), "");
  assert.equal(refusal(`type query = {target: string, text: string}
type logAnswer = {summary: string, url: option<string>, counts: json}
let q: Actions.action<query, logAnswer> = Actions.action("cloudflare", "query_logs")
ignore(Actions.read(q, {target: "billing-api", text: "30 error"})->wait)`), "");
  // A write action called through Actions.read is settled Broke immediately by the host before delivery.
  const writeViaRead = `type command = {target: string, text: string}
type done = {summary: string}
let send: Actions.action<command, done> = Actions.action("slack", "post")
switch Actions.read(send, {target: "#general", text: "nope"})->wait {
| Broke(why) => why
| _ => "unexpected"
}`;
  const blocked = nornStep()({ spaceId: "s", channelId: "c", programId: "p", source: writeViaRead, nowMs: 1_000, stopReason: null,
    ledger: nornStartLedger(1_000), requests: [] });
  assert.equal(blocked.result.status, "completed");
  assert.deepEqual(blocked.write.ledger.ended, { status: "completed", at: 1_000, result: { type: "string", value: "slack post is not a read-only action" }, error: null });
});

test("Actions.read answers with structured JSON values readable via JSON.* and previews cleanly in nornFlow", () => {
  const source = `type query = {target: string, text: string}
type dbAnswer = {summary: string, url: option<string>, rows: json}
let q: Actions.action<query, dbAnswer> = Actions.action("cloudflare", "query_database")
switch Actions.read(q, {target: "trace-db", text: "SELECT failures FROM t"})->wait {
| Answered(r) => switch JSON.asList(r.rows) {
  | Some([first, ..._]) => switch JSON.get(first, "failures") {
    | Some(v) => switch JSON.asInt(v) { | Some(n) => if n >= 10 { "alert" } else { "ok" } | None => "bad" }
    | None => "missing"
    }
  | _ => "empty"
  }
| Revoked => "revoked"
| _ => "broke"
}`;
  const checked = checkNornProgram(source);
  assert.equal("refusal" in checked, false, "refusal" in checked ? checked.refusal : "");
  const flow = nornFlow(checked.code, nornStartLedger(1_000), 1_000);
  assert.deepEqual([flow[0].kind, flow[0].holder, flow[0].verb], ["ask", "@Cloudflare", "read"]);
  assert.match(flow[0].text, /^Read query_database/u);

  const ledger = nornStartLedger(1_000);
  const first = nornStep()({ spaceId: "s", channelId: "c", programId: "p", source, nowMs: 1_000, stopReason: null, ledger, requests: [] });
  assert.equal(first.write.requests.length, 1);
  const [req] = first.write.requests;
  const reply = nornActionAnswer({ summary: "trace-db: 1 row", data: { rows: [{ failures: 12 }] } });
  const done = nornStep({ requestId: req.requestId, epoch: req.epoch, reply })({
    spaceId: "s", channelId: "c", programId: "p", source, nowMs: 2_000, stopReason: null,
    ledger: first.write.ledger, requests: first.write.requests,
  });
  assert.equal(done.result.status, "completed");
  assert.deepEqual(done.write.ledger.ended, { status: "completed", at: 2_000, result: { type: "string", value: "alert" }, error: null });
});

test("the flow of a program that asks an app reads as the app, approved and then done", () => {
  const checked = checkNornProgram(publishing);
  const steps = nornFlow(checked.code, nornStartLedger(1_000), 1_000);
  const [approve] = steps;
  assert.deepEqual([approve.kind, approve.holder, approve.verb, approve.main], ["ask", "@X", "prepare", "answered"]);
  assert.match(approve.text, /^Approve publish_video: /u);
  assert.deepEqual(steps.slice(1, 3).map(each => [each.kind, each.holder ?? null, each.text ?? null]),
    [["wait", null, null], ["ask", "@X", "Do publish_video, as approved"]]);
});

test("guardRunningNornBlocks refuses silently removing or breaking running programs and their libraries", () => {
  const lib = `\`\`\`norn 1 lib Helper\nlet greet = who => say(who, "hi")\n\`\`\``;
  const prog = (name, body) => `\`\`\`norn 1 run ${name}\n${body}\n\`\`\``;
  const page = `# Ops\n\nNotes.\n\n${lib}\n\n${prog("daily", `Helper.greet(@codex)`)}\n\n${prog("watch", `after(1d)->wait`)}\n`;
  const running = [{ name: "daily" }, { name: "watch" }];

  // Prose-only edit passes.
  assert.deepEqual(guardRunningNornBlocks(page, page.replace("Notes.", "Updated notes."), running), []);

  // Silent removal of a running block is refused; explicit removePrograms allows it.
  const withoutWatch = `# Ops\n\nNotes.\n\n${lib}\n\n${prog("daily", `Helper.greet(@codex)`)}\n`;
  assert.deepEqual(
    guardRunningNornBlocks(page, withoutWatch, running).map(v => [v.name, v.reason]),
    [["watch", "removed"]],
  );
  assert.deepEqual(
    guardRunningNornBlocks(page, withoutWatch, running, { removePrograms: new Set(["watch"]) }),
    [],
  );

  // A mangled closing fence that swallows subsequent running blocks is caught.
  const mangled = page.replace(`Helper.greet(@codex)\n\`\`\``, `Helper.greet(@codex)\n\`\``);
  assert.deepEqual(
    guardRunningNornBlocks(page, mangled, running).map(v => [v.name, v.reason]),
    [["daily", "broken"], ["watch", "removed"]],
  );

  // Syntax error introduced into a running block is refused.
  const brokenDaily = page.replace(`Helper.greet(@codex)`, `run(@codex, "missing wait")`);
  assert.deepEqual(
    guardRunningNornBlocks(page, brokenDaily, running).map(v => [v.name, v.reason]),
    [["daily", "broken"]],
  );

  // Duplicate block name colliding with a running block is refused.
  const duplicate = `${page}\n${prog("watch", `after(2d)->wait`)}\n`;
  assert.deepEqual(
    guardRunningNornBlocks(page, duplicate, running).map(v => [v.name, v.reason]),
    [["watch", "broken"]],
  );

  // Removing or breaking a Space library used by a running block is refused.
  const withoutLib = `# Ops\n\nNotes.\n\n${prog("daily", `Helper.greet(@codex)`)}\n\n${prog("watch", `after(1d)->wait`)}\n`;
  assert.deepEqual(
    guardRunningNornBlocks(page, withoutLib, running).map(v => [v.name, v.reason]),
    [["daily", "broken"]],
  );
  const brokenLib = page.replace(`let greet = who => say(who, "hi")`, `let greet = (`);
  assert.deepEqual(
    guardRunningNornBlocks(page, brokenLib, running).map(v => [v.name, v.reason]),
    [["daily", "broken"]],
  );

  // Unsupported future edition header (`norn 2 run`) is allowed so the running program stays alive.
  const futureEdition = page.replace("norn 1 run watch", "norn 2 run watch");
  assert.deepEqual(guardRunningNornBlocks(page, futureEdition, running), []);

  // A page whose block was already broken before the edit does not deadlock unrelated prose edits.
  assert.deepEqual(
    guardRunningNornBlocks(brokenDaily, brokenDaily.replace("Notes.", "Other note."), running),
    [],
  );
});

test("page program branches (Std.each and keyed spawn) route requests to isolated deterministic branch conversations", async () => {
  const { nornBranchConversationId } = await import("../src/norn-branches.ts");
  const { hold, holdKind } = await import("../src/vendor/norn/runtime/ledger.ts");
  const { text } = await import("../src/vendor/norn/runtime/value.ts");

  // 1. Keyed spawn branches on a Page program get distinct branch conversations.
  const spawnSource = `let a = spawn(~key="alpha", () => ask(@codex, "Task A")->wait)
let b = spawn(~key="beta", () => ask(@codex, "Task B")->wait)
ignore(a->wait)
b->wait`;
  const spawnState = {
    spaceId: "space", channelId: "ch-prog", programId: "prog-spawn",
    pageId: "page-1", pageName: "ops",
    source: spawnSource, nowMs: 1_000, stopReason: null,
    ledger: nornStartLedger(1_000), requests: [],
  };
  const s1 = nornStep()(structuredClone(spawnState));
  assert.equal(s1.result.status, "running");
  assert.equal(s1.write.requests.length, 2);
  const reqA = s1.write.requests.find(r => s1.write.ledger.requests[r.requestId].text === "Task A");
  const reqB = s1.write.requests.find(r => s1.write.ledger.requests[r.requestId].text === "Task B");
  assert.equal(reqA.channelId, nornBranchConversationId("page-1", "ops", "spawn:alpha"));
  assert.equal(reqB.channelId, nornBranchConversationId("page-1", "ops", "spawn:beta"));
  assert.notEqual(reqA.channelId, reqB.channelId);
  assert.notEqual(reqA.channelId, "ch-prog");
  assert.equal(s1.result.branches.length, 2);
  assert.ok(s1.result.wakeChannels.includes(reqA.channelId));
  assert.ok(s1.result.wakeChannels.includes(reqB.channelId));

  // 2. Std.each over Holds routes each held partition to its own branch conversation, and retracting one wakes only that branch.
  const libSource = `pub type site = { name: string }`;
  const eachSource = `open Std
needs Products
let sites = Holds.kind("page", "Products.site")
each(sites, site => {
  switch site->Holds.sample {
  | Some(s) =>
    ignore(ask(@codex, "Check " ++ s.name)->wait)
    ()
  | None => ()
  }
})`;
  const eachLedger = nornStartLedger(2_000);
  const kind = holdKind("page", "Products.site");
  hold(eachLedger, kind, "page-a", { type: "record", fields: { name: text("Alpha") } }, 2_000);
  hold(eachLedger, kind, "page-b", { type: "record", fields: { name: text("Beta") } }, 2_000);
  const eachState = {
    spaceId: "space", channelId: "ch-each", programId: "prog-each",
    pageId: "page-ops", pageName: "users",
    source: eachSource, nowMs: 2_000, stopReason: null,
    ledger: eachLedger, requests: [],
  };
  const e1 = nornStep(undefined, undefined, { libraries: { Products: libSource } })(structuredClone(eachState));
  assert.equal(e1.result.status, "running");
  assert.equal(e1.write.requests.length, 2);
  const alphaReq = e1.write.requests.find(r => e1.write.ledger.requests[r.requestId].text === "Check Alpha");
  const betaReq = e1.write.requests.find(r => e1.write.ledger.requests[r.requestId].text === "Check Beta");
  assert.equal(alphaReq.channelId, nornBranchConversationId("page-ops", "users", "each:page-a"));
  assert.equal(betaReq.channelId, nornBranchConversationId("page-ops", "users", "each:page-b"));
  assert.notEqual(alphaReq.channelId, betaReq.channelId);

  // Retract page-b: page-b's open request is Cancelled and its branch channel is woken; page-a stays untouched.
  const nextLedger = structuredClone(e1.write.ledger);
  hold(nextLedger, kind, "page-b", null, 3_000);
  const e2 = nornStep()({
    ...eachState,
    nowMs: 3_000,
    ledger: nextLedger,
    requests: e1.write.requests.map(r => ({
      ...r, deliveryMessageId: `norn:${r.requestRef}:0`, delivered: true, abandoned: false, brokeOff: false,
    })),
  });
  assert.equal(e2.write.ledger.requests[alphaReq.requestId].reply, null);
  assert.equal(e2.write.ledger.requests[betaReq.requestId].reply?.tag, "Cancelled");
  assert.ok(e2.result.wakeChannels.includes(betaReq.channelId));
  assert.ok(!e2.result.wakeChannels.includes(alphaReq.channelId));
});

test("norn 1 facts blocks validate against Space libraries, ignore prose edits, and suppress self-trigger via editorConversationId", async () => {
  const { checkPageFactBlock, collectSpaceLibraries, nornFactBlocks, nornProgramProblems, pageFactsKey } = await import("../src/norn-host.ts");
  const { text } = await import("../src/vendor/norn/runtime/value.ts");

  const libPage = `# Libs\n\n\`\`\`norn 1 lib Products\npub type cadence = Daily | Weekly\npub type site = { name: string, cadence: cadence }\n\`\`\`\n`;
  const catalog = collectSpaceLibraries([{ pageId: "lib-page", body: libPage }]);

  const factPage = (prose, cadence = "Daily") =>
    `# Alpha\n\n${prose}\n\n\`\`\`norn 1 facts Products.site\n{ name: "Alpha", cadence: ${cadence} }\n\`\`\`\n`;

  // Prose-only edits leave pageFactsKey identical.
  assert.equal(pageFactsKey(factPage("Old prose")), pageFactsKey(factPage("Updated prose")));
  assert.notEqual(pageFactsKey(factPage("Same", "Daily")), pageFactsKey(factPage("Same", "Weekly")));

  // Valid fact block checks to a typed Norn value; invalid fact block reports diagnostics in nornProgramProblems.
  const [block] = nornFactBlocks(factPage("Note"));
  const valid = checkPageFactBlock(block, catalog);
  assert.equal(valid.ok, true);
  assert.equal(valid.value.type, "record");
  assert.equal(valid.value.fields.name.value, "Alpha");
  assert.deepEqual(nornProgramProblems(factPage("Note"), catalog), []);

  const badPage = `# Alpha\n\n\`\`\`norn 1 facts Products.site\n{ name: 42, cadence: Daily }\n\`\`\`\n`;
  const problems = nornProgramProblems(badPage, catalog);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].source, "```norn 1 facts Products.site");

  // Anti-self-trigger: a hold update authored from the program's own conversation or branch conversation
  // updates the held value for next sample without emitting on Holds.changes (notify: false).
  const changesSource = `open Std
needs Products
let sites = Holds.kind("page", "Products.site")
let alpha = Holds.held(sites, "page-a")
Holds.changes(alpha)->forEach(~key="watch", v =>
  switch v {
  | Some(s) => ignore(ask(@codex, "Changed " ++ s.name)->wait)
  | None => ()
  }
)`;
  const state = {
    spaceId: "space", channelId: "ch-prog", programId: "prog-self",
    pageId: "page-ops", pageName: "watch",
    source: changesSource, nowMs: 1_000, stopReason: null,
    ledger: nornStartLedger(1_000), requests: [],
  };
  const s1 = nornStep(undefined, undefined, { libraries: catalog.libraries })(structuredClone(state));
  assert.deepEqual(s1.result.holding, ["page:Products.site"]);
  assert.ok(s1.write.waits.some(w => w.type === "hold" && w.kind === "page:Products.site"));

  // Update authored from the program's own conversation -> notify: false -> value stored, zero requests opened!
  const sSelf = nornStep(undefined, undefined, {
    holds: [{ source: "page", typeName: "Products.site", id: "page-a", value: { type: "record", fields: { name: text("Alpha"), cadence: { type: "variant", name: "Daily", args: [] } } } }],
    editorConversationId: "ch-prog",
  })({ ...state, nowMs: 2_000, ledger: structuredClone(s1.write.ledger) });
  assert.equal(sSelf.write.requests.length, 0);
  assert.equal(sSelf.write.ledger.holds["page:Products.site"]["page-a"].value.fields.name.value, "Alpha");

  // Same value repeated -> no-op returns write: null.
  const sRepeat = nornStep(undefined, undefined, {
    holds: [{ source: "page", typeName: "Products.site", id: "page-a", value: { type: "record", fields: { name: text("Alpha"), cadence: { type: "variant", name: "Daily", args: [] } } } }],
  })({ ...state, nowMs: 2_500, ledger: structuredClone(sSelf.write.ledger) });
  assert.equal(sRepeat.write, null);

  // Update authored from outside (different value, human/external conversation) -> notify: true -> wakes Holds.changes!
  const sExt = nornStep(undefined, undefined, {
    holds: [{ source: "page", typeName: "Products.site", id: "page-a", value: { type: "record", fields: { name: text("Alpha v2"), cadence: { type: "variant", name: "Weekly", args: [] } } } }],
  })({ ...state, nowMs: 3_000, ledger: structuredClone(sSelf.write.ledger) });
  assert.equal(sExt.write.requests.length, 1);
  assert.equal(sExt.write.ledger.requests[sExt.write.requests[0].requestId].text, "Changed Alpha v2");
});

test("nornStep routes requests inside spawn -> Std.each -> nested forEach to the innermost per-item branch", async () => {
  const { text } = await import("../src/vendor/norn/runtime/value.ts");
  const { hold, holdKind } = await import("../src/vendor/norn/runtime/ledger.ts");

  const lib = `pub type product = { name: string }`;
  const source = `open Std
needs Users

let overview = spawn(~key="overview", () =>
  every(1d, ~from=2026-11-26T13:50:00Z)->forEach(~key="overview", _ =>
    ignore(run(@claude, "overview report")->wait)))

let reports = spawn(~key="reports", () =>
  each(Holds.kind("page", "Users.product"), h => switch Holds.sample(h) {
  | Some(_) =>
    every(1d, ~from=2026-11-26T13:10:00Z)->forEach(~key="round", _ => switch Holds.sample(h) {
    | Some(r) => ignore(run(@claude, "report " ++ r.name)->wait)
    | None => ()
    })
  | None => ()
  }))

ignore(all([overview, reports]))`;

  const t0 = Date.parse("2026-11-26T13:00:00Z");
  const ledger = nornStartLedger(t0);
  hold(ledger, holdKind("page", "Users.product"), "page-alpha", { type: "record", fields: { name: text("Alpha") } }, t0);
  hold(ledger, holdKind("page", "Users.product"), "page-beta", { type: "record", fields: { name: text("Beta") } }, t0);

  const baseState = {
    spaceId: "space", channelId: "ch-users", programId: "prog-users",
    pageId: "page-users", pageName: "users",
    source, nowMs: t0, stopReason: null, ledger, requests: [],
  };

  // Initial pass before timers fire: all 4 branches (overview, reports, page-alpha, page-beta) exist.
  const s0 = nornStep(undefined, undefined, { libraries: { Users: lib } })(structuredClone(baseState));
  assert.equal(s0.result.status, "running");
  assert.equal(s0.write.requests.length, 0);
  const overviewBranch = s0.result.branches.find(b => b.label === "overview");
  const reportsBranch = s0.result.branches.find(b => b.label === "reports");
  const alphaBranch = s0.result.branches.find(b => b.label === "page-alpha");
  const betaBranch = s0.result.branches.find(b => b.label === "page-beta");
  assert.ok(overviewBranch && reportsBranch && alphaBranch && betaBranch);

  // At 13:10:05Z, nested `every(...)->forEach(~key="round")` fires inside `spawn(~key="reports", () => each(...))`.
  // Each product request must route to its own product branch, NOT the outer `reports` spawn!
  const t1 = Date.parse("2026-11-26T13:10:05Z");
  const s1 = nornStep(undefined, undefined, { libraries: { Users: lib } })({
    ...baseState, nowMs: t1, ledger: structuredClone(s0.write.ledger),
  });
  assert.equal(s1.write.requests.length, 2);
  const alphaReq = s1.write.requests.find(r => s1.write.ledger.requests[r.requestId].text === "report Alpha");
  const betaReq = s1.write.requests.find(r => s1.write.ledger.requests[r.requestId].text === "report Beta");
  assert.ok(alphaReq && betaReq);
  assert.equal(alphaReq.channelId, alphaBranch.channelId);
  assert.equal(betaReq.channelId, betaBranch.channelId);
  assert.notEqual(alphaReq.channelId, reportsBranch.channelId);
  assert.notEqual(betaReq.channelId, reportsBranch.channelId);
  assert.ok(s1.result.wakeChannels.includes(alphaBranch.channelId));
  assert.ok(s1.result.wakeChannels.includes(betaBranch.channelId));

  // At 13:50:05Z, overview fires and routes to the `overview` branch.
  const t2 = Date.parse("2026-11-26T13:50:05Z");
  const s2 = nornStep(undefined, undefined, { libraries: { Users: lib } })({
    ...baseState,
    nowMs: t2,
    ledger: structuredClone(s1.write.ledger),
    requests: s1.write.requests.map(r => ({
      ...r, deliveryMessageId: `norn:${r.requestRef}:0`, delivered: true, abandoned: false, brokeOff: false,
    })),
  });
  const overviewReq = s2.write.requests.find(r => s2.write.ledger.requests[r.requestId].text === "overview report");
  assert.ok(overviewReq);
  assert.equal(overviewReq.channelId, overviewBranch.channelId);
});

