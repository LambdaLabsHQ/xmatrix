import assert from "node:assert/strict";
import test from "node:test";
import { checkNornProgram, nornDeliveryBody, nornProgramIn, nornStartLedger, nornStep, readNornAnswer } from "../src/norn-host.ts";

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
  const person = program(`switch ask(@daniel, "Approve?")->wait { | Broke(why) => why | other => fail(other) }`);
  assert.equal(person.step().result.status, "completed");
  assert.match(person.state.ledger.ended.result.value, /cannot deliver a request to @daniel/u);
  const group = program(`run(anyOf([@daniel, @codex, @claude]), "Audit")->wait`);
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
