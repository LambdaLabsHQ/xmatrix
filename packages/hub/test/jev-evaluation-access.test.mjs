import assert from "node:assert/strict";
import test from "node:test";
import { jevEvaluationScope } from "../src/jev-evaluation-access.ts";

test("Human evaluation requires current Pro membership in the requested Space", async () => {
  const user = { id: "human" };
  const noRun = async () => assert.fail("Human admission must not resolve a Run");
  const readPlan = async (spaceId, userId) => {
    assert.equal(userId, "human");
    if (spaceId === "outside") throw new Error("not a member");
    return spaceId === "pro" ? "pro" : "free";
  };
  await assert.rejects(jevEvaluationScope(user, null, noRun, readPlan, true), error => error.status === 403);
  await assert.rejects(jevEvaluationScope(user, "outside", noRun, readPlan, true), /not a member/);
  await assert.rejects(jevEvaluationScope(user, "free", noRun, readPlan, true), error => error.status === 403);
  assert.deepEqual(await jevEvaluationScope(user, "pro", noRun, readPlan, true), { ownerUserId: "human", spaceId: "pro" });
  assert.equal((await jevEvaluationScope(user, "free", noRun, readPlan, false)).spaceId, "free",
    "self-hosted unmetered policies impose no Pro plan");
});

test("Agent evaluation derives its Space and owner from the revalidated Run", async () => {
  const user = { id: "agent", agentRun: { spaceId: "forged", ownerUserId: "forged" } };
  const run = async () => ({ spaceId: "birth-space", ownerUserId: "owner" });
  const noPlan = async () => assert.fail("a verified live Run may evaluate in its Free Space");
  assert.deepEqual(await jevEvaluationScope(user, null, run, noPlan, true), { ownerUserId: "owner", spaceId: "birth-space" });
  await assert.rejects(jevEvaluationScope(user, "elsewhere", run, noPlan, true), error => error.status === 403);
  await assert.rejects(jevEvaluationScope(user, null, async () => { throw new Error("expired"); }, noPlan, true), /expired/);
});
