import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentBillingReadRoute,
  billingReadSubject,
  agentSpaceStatus,
} from "../src/billing-read-access.ts";
const principal = { ownerUserId: "owner-1", spaceId: "space-1", runId: "run-1", runKind: "channel-instance" };
const agent = { id: "agent-run:run-1", email: "unused@example.com", agentRun: principal };
const request = (path, method = "GET") => new Request(`https://hub.example${path}`, { method });

test("Agent billing route admission is GET-only, exact and birth-Space bound", () => {
  for (const path of ["/api/spaces/space-1/billing"]) {
    assert.equal(agentBillingReadRoute(request(path), principal), true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(agentBillingReadRoute(request(path, method), principal), false);
    }
    assert.equal(agentBillingReadRoute(request(path), { ...principal, runKind: "channel-about-session" }), false);
  }
  for (const path of ["/api/ai-subscription", "/api/ai-subscription/plans", "/api/ai-subscription/usage", "/api/ai-subscription/trial", "/api/ai-subscription/checkout", "/api/ai-subscription/portal",
    "/api/spaces/space-2/billing", "/api/spaces/%ZZ/billing", "/api/spaces/space-1/billing/reconcile"]) {
    assert.equal(agentBillingReadRoute(request(path), principal), false);
  }
});

test("billing subject comes from revalidated signed owner, never Agent subject or caller id", async () => {
  let checks = 0;
  const result = await billingReadSubject(agent, async () => { checks++; return principal; });
  assert.equal(checks, 1);
  assert.equal(result.userId, "owner-1");
  await assert.rejects(billingReadSubject(agent, async () => { throw new Error("Run ended or revoked"); }));
  await assert.rejects(billingReadSubject(agent, async () => principal, "space-2"));
  await assert.rejects(billingReadSubject(agent, async () => ({ ...principal, ownerUserId: "" })));
  await assert.rejects(billingReadSubject(agent, async () => ({ ...principal, runKind: "channel-about-session" })));
  assert.equal((await billingReadSubject(agent, async () => principal, "space-1")).userId, "owner-1");
});

test("Human billing keeps its identity and does not require an Agent Run", async () => {
  assert.deepEqual(await billingReadSubject({ id: "human-1" }, async () => { throw new Error("must not run"); }), { userId: "human-1" });
});

test("Space projection does not grant management or expose payment identifiers", () => {
  const result = agentSpaceStatus({ billing: { plan: "pro", canManage: true, secret: "private",
    subscription: { status: "active", customerId: "private" }, seats: { used: 2, limit: 5 },
    freeUsage: { acceptedMessages: 0, limit: 500, remaining: 500 } } });
  assert.equal(result.billing.canManage, false);
  assert.equal(result.billing.secret, undefined);
  assert.deepEqual(result.billing.subscription, { status: "active" });
});

// Workers-bound auth imports cloudflare:email. Pin route wiring as a source
// contract, in addition to the executable policy/lifecycle tests above.

test("a deployment without plans serves no Space billing routes", async () => {
  const { Hono } = await import("hono");
  const { registerIndexRoutesBilling } = await import("../src/index-routes-billing.ts");
  const app = new Hono();
  registerIndexRoutesBilling(app);
  for (const [method, path] of [
    ["GET", "/api/spaces/space-1/billing"],
    ["POST", "/api/spaces/space-1/billing/checkout"],
    ["POST", "/api/spaces/space-1/billing/portal"],
    ["POST", "/api/spaces/space-1/billing/reconcile"],
    ["POST", "/api/billing/stripe/webhook"],
  ]) {
    assert.equal((await app.request(path, { method }, {})).status, 404, `${method} ${path}`);
  }
});
