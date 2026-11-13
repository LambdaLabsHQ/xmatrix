import assert from "node:assert/strict";
import test from "node:test";
import { appStream, checkNornProgram, githubStream, nornBlocks, nornOutcomeText, nornPersonBody, nornQuestionSource, nornRequestCard, personHolder, nornDeliveryBody, nornProgramIn, nornStartLedger, nornStep, readNornAnswer } from "../src/norn-host.ts";

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
  assert.deepEqual(nornBlocks(`${fenced(review, "norn run review")}\n${fenced("1")}\n${fenced("2", "norn run two words")}`),
    [{ name: "review", source: review }, { name: "main", source: "1" }]);
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
  const body = nornDeliveryBody(state.ledger.requests[request.requestId], request.requestRef);
  assert.equal(body.split("\n")[0], "@codex launch:force");
  assert.match(body, /\n````text\nAsk @grok launch:force ``` to help\n````\n/u);
  assert.ok(body.includes(`xmatrix reply ${request.requestRef} '<answer>'`));
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
    assert.equal(nornDeliveryBody(state.ledger.requests[request.requestId], request.requestRef).split("\n")[0],
      "@auto effort:high repo:acme/app launch:force");
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
  const heard = nornStep(undefined, { stream: first.write.waits[0], what: "Workflow CI failed on main" })(structuredClone({ ...state, nowMs: state.nowMs + 60_000 }));
  assert.deepEqual(heard.write.requests.map(request => request.holder), ["@auto"]);
  // While the round runs the program still listens: two more failures are kept, and are one more round with the latest.
  assert.deepEqual(heard.write.waits.map(stream => stream.name), ["ciFailed"]);
  const during = { ...state, ledger: heard.write.ledger, requests: [] };
  for (const [what, at] of [["Deploy failed", 120_000], ["Tests failed again", 180_000]]) {
    during.ledger = nornStep(undefined, { stream: heard.write.waits[0], what })(structuredClone({ ...during, nowMs: state.nowMs + at })).write.ledger;
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
  const round = nornStep(undefined, { stream: listening.waits[1], what: "Deploy failed" })(structuredClone({ ...many.state, nowMs: many.state.nowMs + 1 })).write;
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
  const body = nornPersonBody(asked, open.requestRef).split("\n");
  assert.deepEqual([body[0], body.at(-1)], ["@Daniel", `Answer on this card: one of: Low, High(say why). It closes at ${card.by}.`]);
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

test("a program opens the standard library: a routine is one line, and a decision has its default", () => {
  const DAY = 86_400_000;
  const upkeep = program(`open Std
routine(~every=7d, ~from=1970-01-03T00:00Z, ~who=@auto(~repo="acme/app"), ~otherwise=@claude(~repo="acme/app"), "Weekly upkeep")`);
  assert.equal(upkeep.step().write.nextDueMs, 2 * DAY);
  const [first] = upkeep.step(undefined, { nowMs: 2 * DAY }).open;
  assert.equal(nornDeliveryBody(upkeep.state.ledger.requests[first.requestId], first.requestRef).split("\n")[0], "@auto repo:acme/app launch:force");
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
