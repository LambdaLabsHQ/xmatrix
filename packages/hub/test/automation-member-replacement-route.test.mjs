import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";

import {
  AUTOMATION_MAX_INTERVAL_MINUTES,
  AUTOMATION_MIN_INTERVAL_MINUTES,
  automationEvalInput,
  automationExpression,
  automationIntervalMinutes,
  automationPayload,
} from "../src/index-shared.ts";
import { registerIndexRoutesAutomation } from "../src/index-routes-automation.ts";

// Real Hono handlers and evaluator payload builders; authentication, the
// authority transport and the route directory are recorded instead.
const state = { user: "member", calls: [], tasks: new Map() };

function authoredTask(authorityRootUserId = "author") {
  const input = {
    datum: { kind: "text", ref: "automation:task", language: "natural-language", text: "Review the day" },
    envRef: { root: { kind: "channel", id: "channel" }, actor: { kind: "user", id: authorityRootUserId },
      authorityRootUserId },
    resume: { kind: "interval", intervalMinutes: 60 },
    lineage: { rootMessageId: "automation:task", depth: 0, budget: 128 },
  };
  return {
    id: "task", version: 3, ownerUserId: authorityRootUserId, authorityRootUserId,
    channelId: "channel", enabled: true,
    nextRunAt: "2026-09-26T00:00:00.000Z", intervalMinutes: 60, name: "Daily review",
    payloadVersion: 3,
    payload: { payloadVersion: 3, name: "Daily review", intervalMinutes: 60, input },
    input,
    capabilities: { update: true, pause: true, resume: false, delete: true, requestPause: false,
      reasonRequired: false },
  };
}

const boundary = {
  AUTOMATION_MAX_INTERVAL_MINUTES,
  AUTOMATION_MIN_INTERVAL_MINUTES,
  automationEvalInput,
  automationExpression,
  automationIntervalMinutes,
  automationPayload,
  actorUserId: (user) => user.id,
  automationAgentContext: () => { throw new Error("unexpected Agent path"); },
  productCommandId: () => randomUUID(),
  requireAuth: async () => ({ id: state.user }),
  requireHumanAuth: (user) => user,
  requireLiveAgentRun: async () => { throw new Error("unexpected Agent path"); },
  requestErrorResponse: (c, error) => c.json({ error: error.message }, error.status || 500),
  listAutomations: async () => { throw new Error("unexpected list"); },
  async getAutomation(_env, input) {
    state.calls.push({ kind: "get", input });
    const task = state.tasks.get(input.automationId);
    if (!task) throw Object.assign(new Error("Automation not found"), { status: 404 });
    return { task };
  },
  async commitAutomation(_env, input) {
    state.calls.push({ kind: "domain", input });
    const env = input.payload.input.envRef;
    const next = { ...authoredTask(env.authorityRootUserId), id: input.automationId,
      version: input.expectedVersion + 1, enabled: input.enabled, input: input.payload.input,
      payload: input.payload };
    if (input.replacesAutomation) state.tasks.delete(input.replacesAutomation.automationId);
    state.tasks.set(input.automationId, next);
    return {};
  },
};

const app = new Hono();
registerIndexRoutesAutomation(app, boundary);

function reset(user, authorityRootUserId = "author") {
  state.user = user;
  state.calls.length = 0;
  state.tasks = new Map([["task", authoredTask(authorityRootUserId)]]);
}

const patch = (body) => app.request("https://hub.test/api/automations/task", {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}, {});
const command = () => state.calls.find((call) => call.kind === "domain")?.input;

test("a member's rewrite of another author's evaluation replaces it with one that runs as the member", async () => {
  reset("member");
  const response = await patch({ expectedVersion: 3, expression: { kind: "text", language: "natural-language", text: "Review the week" }, intervalMinutes: 120 });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  const input = command();
  assert.notEqual(input.automationId, "task");
  assert.equal(input.expectedVersion, 0);
  assert.equal(input.actorUserId, "member");
  assert.deepEqual(input.principal, { kind: "user", id: "member" });
  assert.deepEqual(input.replacesAutomation, { automationId: "task", expectedVersion: 3 });
  assert.deepEqual(input.payload.input.envRef.actor, { kind: "user", id: "member" });
  assert.equal(input.payload.input.envRef.authorityRootUserId, "member");
  assert.equal(input.payload.input.datum.text, "Review the week");
  assert.equal(input.payload.intervalMinutes, 120);
  assert.deepEqual(input.payload.input.lineage,
    { rootMessageId: `automation:${input.automationId}`, depth: 0, budget: 128 });
  // The replacement keeps the schedule's state and due time.
  assert.equal(input.enabled, true);
  assert.equal(input.nextRunAt, "2026-09-26T00:00:00.000Z");
  assert.equal(body.automation.id, input.automationId);
  assert.equal(body.replacedAutomationId, "task");
});

test("the author's own rewrite stays in place under the same authority", async () => {
  reset("author");
  const response = await patch({ expectedVersion: 3, expression: { kind: "text", language: "natural-language", text: "Review the week" } });
  assert.equal(response.status, 200, await response.text());
  const input = command();
  assert.equal(input.automationId, "task");
  assert.equal(input.expectedVersion, 3);
  assert.equal(input.replacesAutomation, undefined);
  assert.equal(input.payload.input.envRef.authorityRootUserId, "author");
});

test("a member's pause keeps the author's evaluation and authority", async () => {
  reset("member");
  const response = await app.request("https://hub.test/api/automations/task/pause", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 3 }),
  }, {});
  assert.equal(response.status, 200, await response.text());
  const input = command();
  assert.equal(input.automationId, "task");
  assert.equal(input.enabled, false);
  assert.equal(input.replacesAutomation, undefined);
  assert.equal(input.payload.input.envRef.authorityRootUserId, "author");
});

test("a replacement is refused without update capability or on a stale version", async () => {
  reset("member");
  state.tasks.get("task").capabilities.update = false;
  assert.equal((await patch({ expectedVersion: 3, expression: { kind: "text", language: "natural-language", text: "x" } })).status, 403);
  reset("member");
  assert.equal((await patch({ expectedVersion: 2, expression: { kind: "text", language: "natural-language", text: "x" } })).status, 409);
  assert.equal(command(), undefined);
});
