import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { agentRunHttpRouteAllowed } from "../src/index-shared.ts";
import { registerIndexRoutesAutomation } from "../src/index-routes-automation.ts";

// Clients released while schedule lines ran still call these routes. The real handlers and the real
// authentication answer here; only the credential is the test deployment's mock token.
const TOKEN = "retired-routes-token";
const env = { XMATRIX_MOCK_AUTH_TOKEN: TOKEN, XMATRIX_MOCK_AUTH_USER_ID: "member" };
const app = new Hono();
registerIndexRoutesAutomation(app);

const call = (method, path, token = TOKEN) => app.request(path, { method,
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(method === "GET" ? {} : { body: JSON.stringify({ expectedVersion: 3, runId: "run" }) }) }, env);

const page = "/api/spaces/space/pages/page/automations";
const READS = [["GET", "/api/automations?spaceId=space"], ["GET", "/api/automations/a1"], ["GET", page]];
const CHANGES = [
  ["PATCH", "/api/automations/a1"], ["DELETE", "/api/automations/a1"], ["POST", "/api/automations/a1/pause"],
  ["POST", "/api/automations/a1/resume"], ["POST", "/api/automations/a1/cancel-execution"],
  ["POST", `${page}/a1/pause`], ["POST", `${page}/a1/resume`], ["POST", `${page}/a1/run`], ["DELETE", `${page}/a1`],
];
const RETIRED = { error: "Schedule lines are retired: write the work as a `norn run` program on its page "
  + "(https://xmatrix.sh/docs/programs)", code: "automations_retired" };

test("a list of schedules is empty, and one schedule is not found", async () => {
  const space = await call("GET", "/api/automations?spaceId=space");
  assert.equal(space.status, 200);
  assert.deepEqual(await space.json(), { automations: [], executionEnabled: false, agentManagementEnabled: false });
  const ofPage = await call("GET", page);
  assert.equal(ofPage.status, 200);
  assert.deepEqual(await ofPage.json(), { automations: [] });
  const one = await call("GET", "/api/automations/a1");
  assert.equal(one.status, 404);
  assert.deepEqual(await one.json(), { error: "Automation not found", code: "not_found", retryable: false });
});

test("every change to a schedule answers that schedule lines are retired", async () => {
  for (const [method, path] of [["POST", "/api/automations"], ...CHANGES]) {
    const response = await call(method, path);
    assert.equal(response.status, 410, `${method} ${path}`);
    assert.deepEqual(await response.json(), RETIRED, `${method} ${path}`);
  }
});

test("a caller without a valid credential is refused before any of those answers", async () => {
  for (const [method, path] of [...READS, ...CHANGES]) {
    for (const token of ["", "not-the-token"]) {
      const response = await call(method, path, token);
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal((await response.json()).code, undefined, `${method} ${path}`);
    }
  }
});

test("an Agent Run reaches the answers a released CLI asks for on its behalf", () => {
  const run = { channelId: "channel", permissions: [] };
  const allowed = (method, path) => agentRunHttpRouteAllowed(new Request(`https://hub.test${path}`, { method }), run);
  for (const [method, path] of [...READS, ["POST", "/api/automations"], ...CHANGES]) {
    if (path.endsWith("/cancel-execution")) continue;
    assert.equal(allowed(method, path), true, `${method} ${path}`);
  }
  // Cancelling an execution was a person's alone.
  assert.equal(allowed("POST", "/api/automations/a1/cancel-execution"), false);
});
