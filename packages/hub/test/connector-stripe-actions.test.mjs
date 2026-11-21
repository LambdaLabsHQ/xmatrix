import assert from "node:assert/strict";
import { test } from "node:test";
import { STRIPE_ACTIONS } from "../src/connectors/actions/stripe.ts";
import { stripeActionCapability } from "../src/connectors/stripe-accounts.ts";
import { connectorActionCatalog } from "../src/connectors/action-catalog.ts";
import { connectorForCommand } from "../src/connectors/registry.ts";
import { usageOf } from "../src/connectors/usage.ts";

const account = "acct_1SbH3vRMzTj9NjJj";

function fixture(reply) {
  const calls = [];
  let connected = [account, "acct_1UMQgmRDtGNQEz6l"];
  const context = {
    credentials: { neverExpose: "stripe-secret-fixture" },
    stripe: {
      accounts: async () => connected,
      request: async (accountId, path) => {
        calls.push({ accountId, path });
        return typeof reply === "function" ? reply(accountId, path) : reply;
      },
    },
  };
  return { context, calls, setAccounts: ids => { connected = ids; } };
}

function parse(action, target, text = "") {
  const input = STRIPE_ACTIONS[action].parse({ target, text });
  assert.equal(typeof input, "object", typeof input === "string" ? input : "");
  return input;
}

test("Stripe read actions are admitted to the executable catalog and exposed for xmatrix call", () => {
  const catalog = connectorActionCatalog("stripe", STRIPE_ACTIONS);
  const expected = [
    "accounts", "list_events", "get_event", "list_payment_intents", "get_payment_intent",
    "list_invoices", "get_invoice", "list_subscriptions", "get_subscription", "list_disputes", "get_dispute",
  ];
  assert.deepEqual([...catalog.keys()].sort(), [...expected].sort());
  for (const { definition, executor } of catalog.values()) {
    assert.equal(definition.effect, "read");
    assert.equal(executor.effect, "read");
  }
  const usage = usageOf(new Set(["stripe"]));
  assert.equal(usage.length, 1);
  assert.equal(usage[0].provider, "stripe");
  assert.equal(usage[0].actions.length, expected.length);
  assert.equal(usage[0].actions.every(action => action.effect === "read" && action.via === "call"), true);
  assert.equal(connectorForCommand(`@stripe:accounts:*`)?.id, "stripe");
  assert.equal(connectorForCommand(`@stripe:get_payment_intent:${account}/pi_123`)?.id, "stripe");
});

test("Stripe actions validate account IDs, object prefixes, limits, timestamps, and allowlisted options", () => {
  for (const [action, target, text] of [
    ["accounts", account, ""],
    ["accounts", "*", "extra"],
    ["list_events", "*", ""],
    ["list_events", "bad_acct", ""],
    ["list_events", account, "limit=0"],
    ["list_events", account, "limit=51"],
    ["list_events", account, "starting_after=pi_123"],
    ["list_events", account, "created_gte=not-a-date"],
    ["list_events", account, "expand=data.object"],
    ["list_events", account, "baretoken"],
    ["list_payment_intents", account, "customer=acct_123"],
    ["list_invoices", account, "status=unknown"],
    ["list_subscriptions", account, "status=unknown"],
    ["list_disputes", account, "payment_intent=in_123"],
    ["get_event", `${account}/pi_123`, ""],
    ["get_payment_intent", `${account}/cs_live_123`, ""],
    ["get_payment_intent", `${account}/../charges`, ""],
    ["get_payment_intent", `${account}/pi_123/extra`, ""],
    ["get_payment_intent", `${account}/pi_123`, "extra"],
    ["get_invoice", `${account}/sub_123`, ""],
    ["get_subscription", `${account}/in_123`, ""],
    ["get_dispute", `${account}/pi_123`, ""],
  ]) {
    assert.equal(typeof STRIPE_ACTIONS[action].parse({ target, text }), "string", `${action}:${target} ${text}`);
  }
});

test("Stripe accounts action lists active account IDs without exposing credentials", async () => {
  const f = fixture({});
  const listed = await STRIPE_ACTIONS.accounts.execute(f.context, parse("accounts", "*"));
  assert.match(listed.summary, /Connected Stripe accounts \(2\):\nacct_1SbH3vRMzTj9NjJj\nacct_1UMQgmRDtGNQEz6l/u);
  assert.doesNotMatch(listed.summary, /stripe-secret-fixture/u);
  f.setAccounts([]);
  assert.match((await STRIPE_ACTIONS.accounts.execute(f.context, {})).summary, /No active OAuth-connected Stripe accounts/u);
  await assert.rejects(STRIPE_ACTIONS.accounts.execute({ credentials: {} }, {}), /Connect a Stripe account/u);
});

test("Stripe PaymentIntent list and get surface decline details, payment method summary, and dashboard link", async () => {
  const pi = {
    id: "pi_3Ue96LRMzTj9NjJj1CoznwVE",
    object: "payment_intent",
    amount: 500,
    amount_received: 0,
    currency: "usd",
    status: "requires_payment_method",
    created: 1795247546,
    livemode: true,
    payment_method_types: ["card", "alipay"],
    metadata: { user_id: "usr_123" },
    last_payment_error: {
      type: "invalid_request_error",
      code: "payment_intent_payment_attempt_expired",
      decline_code: "expired_attempt",
      message: "The latest payment attempt for the PaymentIntent has expired.",
      payment_method: { id: "pm_123", type: "alipay" },
    },
  };
  const f = fixture((_acct, path) => path.startsWith("/v1/payment_intents?")
    ? { object: "list", data: [pi], has_more: true } : pi);

  const listResult = await STRIPE_ACTIONS.list_payment_intents.execute(
    f.context,
    parse("list_payment_intents", account, "limit=10 customer=cus_abc created_gte=2026-11-20T00:00:00Z created_lte=1795300000"),
  );
  assert.equal(f.calls[0].accountId, account);
  const params = new URLSearchParams(f.calls[0].path.split("?")[1]);
  assert.equal(f.calls[0].path.split("?")[0], "/v1/payment_intents");
  assert.equal(params.get("limit"), "10");
  assert.equal(params.get("customer"), "cus_abc");
  assert.equal(params.get("created[gte]"), String(Math.floor(Date.parse("2026-11-20T00:00:00Z") / 1000)));
  assert.equal(params.get("created[lte]"), "1795300000");
  assert.match(listResult.summary, /5\.00 USD \| requires_payment_method/u);
  assert.match(listResult.summary, /payment_intent_payment_attempt_expired/u);
  assert.match(listResult.summary, /method=alipay pm_123/u);
  assert.match(listResult.summary, /starting_after=pi_3Ue96LRMzTj9NjJj1CoznwVE/u);

  const getResult = await STRIPE_ACTIONS.get_payment_intent.execute(
    f.context,
    parse("get_payment_intent", `${account}/${pi.id}`),
  );
  assert.equal(f.calls[1].path, `/v1/payment_intents/${pi.id}`);
  assert.equal(getResult.url, `https://dashboard.stripe.com/${account}/payments/${pi.id}`);
  assert.match(getResult.summary, /code: payment_intent_payment_attempt_expired/u);
  assert.match(getResult.summary, /payment_method: alipay pm_123/u);
  assert.match(getResult.summary, /metadata: user_id=usr_123/u);
});

test("Stripe events, invoices, subscriptions, and disputes format responses and reject object mismatches", async () => {
  const replies = {
    "/v1/events?limit=5&type=payment_intent.payment_failed": {
      object: "list", has_more: false,
      data: [{ id: "evt_1", object: "event", type: "payment_intent.payment_failed", created: 1795247906, livemode: true,
        data: { object: { id: "pi_1", object: "payment_intent", amount: 500, currency: "usd", status: "requires_payment_method" } } }],
    },
    "/v1/events/evt_1": {
      id: "evt_1", object: "event", type: "payment_intent.payment_failed", created: 1795247906, livemode: true,
      data: { object: { id: "pi_1", object: "payment_intent", amount: 500, currency: "usd", status: "requires_payment_method" } },
    },
    "/v1/invoices?limit=20&status=open": {
      object: "list", has_more: false,
      data: [{ id: "in_1", object: "invoice", number: "INV-001", amount_due: 1000, amount_paid: 0, currency: "usd", status: "open", created: 1795200000 }],
    },
    "/v1/invoices/in_1": {
      id: "in_1", object: "invoice", number: "INV-001", amount_due: 1000, amount_paid: 0, amount_remaining: 1000,
      currency: "usd", status: "open", created: 1795200000, livemode: true, lines: { data: [{ amount: 1000, currency: "usd", description: "Pro plan" }] },
    },
    "/v1/subscriptions?limit=20&status=active": {
      object: "list", has_more: false,
      data: [{ id: "sub_1", object: "subscription", status: "active", customer: "cus_1", created: 1795100000, current_period_end: 1797700000 }],
    },
    "/v1/subscriptions/sub_1": {
      id: "sub_1", object: "subscription", status: "active", customer: "cus_1", created: 1795100000, livemode: true,
      items: { data: [{ id: "si_1", quantity: 1, price: { id: "price_1", unit_amount: 1000, currency: "usd", recurring: { interval: "month" } } }] },
    },
    "/v1/disputes?limit=20&payment_intent=pi_1": {
      object: "list", has_more: false,
      data: [{ id: "dp_1", object: "dispute", amount: 500, currency: "usd", status: "needs_response", reason: "fraudulent", payment_intent: "pi_1", created: 1795240000 }],
    },
    "/v1/disputes/dp_1": {
      id: "dp_1", object: "dispute", amount: 500, currency: "usd", status: "needs_response", reason: "fraudulent",
      payment_intent: "pi_1", charge: "ch_1", created: 1795240000, livemode: true, evidence_details: { due_by: 1795840000 },
    },
  };
  const f = fixture((_acct, path) => replies[path] ?? { object: "unexpected", id: "wrong" });

  const evtList = await STRIPE_ACTIONS.list_events.execute(f.context, parse("list_events", account, "limit=5 type=payment_intent.payment_failed"));
  assert.match(evtList.summary, /evt_1 \| payment_intent\.payment_failed \| pi_1 \| 5\.00 USD/u);
  const evtGet = await STRIPE_ACTIONS.get_event.execute(f.context, parse("get_event", `${account}/evt_1`));
  assert.equal(evtGet.url, `https://dashboard.stripe.com/${account}/events/evt_1`);

  const invList = await STRIPE_ACTIONS.list_invoices.execute(f.context, parse("list_invoices", account, "status=open"));
  assert.match(invList.summary, /in_1 \| INV-001 \| 0\.00 USD \| open/u);
  const invGet = await STRIPE_ACTIONS.get_invoice.execute(f.context, parse("get_invoice", `${account}/in_1`));
  assert.equal(invGet.url, `https://dashboard.stripe.com/${account}/invoices/in_1`);
  assert.match(invGet.summary, /Pro plan/u);

  const subList = await STRIPE_ACTIONS.list_subscriptions.execute(f.context, parse("list_subscriptions", account, "status=active"));
  assert.match(subList.summary, /sub_1 \| active \| customer=cus_1/u);
  const subGet = await STRIPE_ACTIONS.get_subscription.execute(f.context, parse("get_subscription", `${account}/sub_1`));
  assert.equal(subGet.url, `https://dashboard.stripe.com/${account}/subscriptions/sub_1`);
  assert.match(subGet.summary, /price_1 10\.00 USD\/month x1/u);

  const dpList = await STRIPE_ACTIONS.list_disputes.execute(f.context, parse("list_disputes", account, "payment_intent=pi_1"));
  assert.match(dpList.summary, /dp_1 \| 5\.00 USD \| needs_response \| fraudulent/u);
  const dpGet = await STRIPE_ACTIONS.get_dispute.execute(f.context, parse("get_dispute", `${account}/dp_1`));
  assert.equal(dpGet.url, `https://dashboard.stripe.com/${account}/disputes/dp_1`);

  await assert.rejects(STRIPE_ACTIONS.get_payment_intent.execute(f.context, parse("get_payment_intent", `${account}/pi_missing`)), /did not return PaymentIntent/u);
});

test("stripeActionCapability enforces account format and endpoint allowlist before any storage or network access", async () => {
  const cap = stripeActionCapability({}, { spaceId: "space-1", channelId: "ch-1", actorUserId: "user-1" });
  await assert.rejects(cap.request("bad_account", "/v1/events?limit=1"), /valid Stripe account ID/u);
  for (const forbidden of [
    "/v1/checkout/sessions",
    "/v1/checkout/sessions/cs_live_123",
    "/v1/customers",
    "/v1/charges/ch_123",
    "/v1/payment_intents/pi_123?expand[]=latest_charge",
    "/v1/events/evt_1?expand=data.object.customer",
    "/v1/events/../charges",
    "https://evil.example/v1/events",
  ]) {
    await assert.rejects(cap.request(account, forbidden), /endpoint is unavailable/u, forbidden);
  }
});
