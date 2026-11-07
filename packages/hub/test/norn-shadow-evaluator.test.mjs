import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nornShadowEvaluator as evaluator } from "../src/norn-shadow-evaluator.ts";
const { programs } = JSON.parse(readFileSync(new URL("./fixtures/norn-shadow-programs.json",import.meta.url),"utf8"));
const selection = { bindingId: "binding",participant: "@codex:2",sourceRef: "execution:binding" };
const evidence = { id: "binding/1/final",runId: "run",instanceId: "instance",executionId: "execution",finalReplyId: "final",declaration: "completed" };
function session(name) {
  const ast = programs[name].ast;
  let snapshot = evaluator.create(ast,0).snapshot;
  return { step(now = 0,input = null) { const result = evaluator.advance(ast,snapshot,selection,input ? { observedAt: now,...input } : null,now); snapshot = result.snapshot; return result; } };
}
function until(session,predicate,now = 0,input = null) {
  for (let i=0;i<30;i++) { const result = session.step(now,input); if (predicate(result)) return result; }
  assert.fail("the finite fixture did not reach its next boundary");
}
test("an exact receipt resumes once; ordinary lifecycle state leaves the candidate waiting",() => {
  const s = session("run");
  assert.equal(s.step().state,"waiting");
  assert.equal(s.step(1,{ ...evidence,finalReplyId: null }).kind,"idle");
  assert.equal(s.step(2,evidence).disposition,"consumed");
  const completed = s.step(3,null);
  assert.equal(completed.state,"completed");
  assert.equal(completed.classification,"equivalent");
  assert.equal(completed.snapshot.machine.control.value.args[0].fields.receipt.value,"final");
  const incomplete = session("run"); incomplete.step();
  assert.equal(incomplete.step(1,{ ...evidence,declaration: "running" }).kind,"idle");
  assert.equal(incomplete.step(2,{ ...evidence,declaration: "failed" }).reason,"unmapped_source_outcome");
});
test("exclusive deadline wins at equality; an earlier recorded answer wins",() => {
  const late = session("deadline");
  late.step();
  const timeout = late.step(3600000,evidence);
  assert.equal(timeout.kind,"timeout"); assert.equal(timeout.disposition,"late");
  assert.equal(late.step(3600001).state,"failed");
  const early = session("deadline"); early.step();
  assert.equal(early.step(3599999,evidence).kind,"wake");
  assert.equal(early.step(3600001).state,"completed");
  const delayed = session("deadline"); delayed.step();
  assert.equal(delayed.step(7200000,{ ...evidence,observedAt: 3599999 }).kind,"wake");
});
test("an independent observation timeout does not settle the request",() => {
  const s = session("independent");
  until(s,r => r.state === "waiting");
  assert.equal(s.step(3600000).kind,"timeout");
  const result = until(s,r => r.state === "completed",3600001);
  assert.equal(result.snapshot.machine.control.value.name,"None");
});
test("handover fences the old holder's receipt, without a replacement interaction",() => {
  const s = session("handover");
  until(s,r => r.state === "waiting");
  const old = s.step(1,evidence);
  assert.equal(old.state,"waiting"); assert.equal(old.disposition,"obsolete");
  assert.equal(s.step(2).kind,"idle");
});
test("a second request cannot reuse one admitted final receipt",() => {
  const s = session("duplicate");
  s.step(); s.step(1,evidence);
  assert.equal(until(s,r => r.state === "waiting",2).reason,"unmapped_request_wait");
  assert.equal(s.step(3).kind,"idle");
});
test("unknown judgements and facts remain unsupported, while pure loops yield",() => {
  for (const name of ["judge","fact"]) {
    const s = session(name),result = s.step(0,evidence);
    assert.equal(result.state,"incomplete"); assert.equal(result.classification,"incomplete");
  }
  const loop = session("loop");
  for (let i=0;i<4;i++) assert.equal(loop.step(i).kind,"yield");
});
test("timers are recorded in checkpoints and wake after a restart",() => {
  const s = session("timer"),waiting = s.step();
  assert.equal(waiting.due,3600000);
  const restored = evaluator.advance(programs.timer.ast,JSON.parse(JSON.stringify(waiting.snapshot)),selection,null,3600000);
  assert.equal(restored.kind,"wake");
  const missed = session("timerDeadline"); missed.step();
  assert.equal(missed.step(10800000).reason,"timer_due","an earlier timer still wins when both it and the deadline are serviced late");
});
