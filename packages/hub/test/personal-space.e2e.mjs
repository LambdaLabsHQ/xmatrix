import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareTestAgentRun } from "./e2e-utils.mjs";
import { personalSpace, withOwnerWorker } from "./owner-worker.mjs";
import { humanHandleShortCode, neutralHumanIdentity } from "@xmatrix/protocol";

const spaceIds = async (call) => (await call("/api/spaces")).body.spaces.map((space) => space.id);
const personal = personalSpace;

test("a person with no Space gets one personal Space, once", () =>
  withOwnerWorker("Ada Lovelace", async ({ call }) => {
    assert.deepEqual(await spaceIds(call), []);
    const space = await personal(call);
    assert.equal(space.name, "Ada Lovelace's Space");
    assert.deepEqual(await spaceIds(call), [space.id]);
    // A second tab or a retry finds a Space already there and adds nothing.
    assert.equal(await personal(call), null);
    assert.deepEqual(await spaceIds(call), [space.id]);
  }));

test("a personal Space is not named after an email address or a generated placeholder name", async () => {
  for (const name of ["owner@example.com", (userId) => neutralHumanIdentity(humanHandleShortCode(userId)).displayName]) {
    await withOwnerWorker(name, async ({ call }) => {
      assert.equal((await personal(call)).name, "My Space");
    });
  }
});

test("someone who already has a Space, as an invitee does, is given no personal one", () =>
  withOwnerWorker("Grace Hopper", async ({ call }) => {
    const created = await call("/api/spaces", { method: "POST", body: { name: "Invited team" } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(await personal(call), null);
    assert.deepEqual(await spaceIds(call), [created.body.space.id]);
  }));

test("an Agent Run cannot create a personal Space for its owner", () =>
  withOwnerWorker("Alan Turing", async ({ worker, token, call }) => {
    const space = await personal(call);
    const run = await prepareTestAgentRun(worker, {
      name: `personal-space-agent-${crypto.randomUUID()}`, agentType: "codex", spaceId: space.id,
    }, token);
    const denied = await call("/api/personal-space", { method: "POST", bearer: run.token });
    assert.equal(denied.status, 401);
  }));
