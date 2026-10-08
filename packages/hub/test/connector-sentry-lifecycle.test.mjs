import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { HUB_ROUTES, hmacHex, sha256Hex } from "@xmatrix/protocol";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { deliveryProven } from "../src/connectors/delivery-proof.ts";
import { parseJsonObject } from "../src/connectors/event-format.ts";
import { ProviderRequestError } from "../src/connectors/http.ts";
import { sentryInstallationClient } from "../src/connectors/sentry-installation.ts";

const env = { CONNECTOR_SENTRY_CLIENT_ID: "fixture-client", CONNECTOR_SENTRY_CLIENT_SECRET: "fixture-secret",
  CONNECTOR_SENTRY_APP_UUID: "11111111-2222-4333-8444-555555555555", CONNECTOR_SENTRY_APP_SLUG: "xmatrix" };
const installationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const readBoundedRequestBody = async (request, max) => {
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.length <= max ? bytes : undefined;
};
const lifecycleModule = await compileCommonJsSourceModule(new URL("../src/connectors/sentry-app-lifecycle.ts", import.meta.url));
const routeModule = await compileCommonJsSourceModule(new URL("../src/index-routes-sentry-installation.ts", import.meta.url));
const connectModule = await compileCommonJsSourceModule(new URL("../src/connectors/sentry-install-connect.ts", import.meta.url));

function lifecycle() {
  const retired = [];
  let failure;
  const imports = {
    "../index-shared": { readBoundedRequestBody }, "./sentry-installation": { sentryInstallationClient },
    "@xmatrix/protocol": { sha256Hex },
    "./sentry-event-identity": { sentryEventIdentity: () => undefined },
    "./sentry-event-drain": { drainSentryEvents: async () => {} },
    "./delivery-proof": { deliveryProven }, "./event-format": { parseJsonObject },
    "./credentials": { connectorCredentialRepository: () => ({ retireSentryInstallation: async input => {
      retired.push(input); if (failure) throw failure; return 1;
    } }) },
  };
  const { handleSentryInstallationDelivery } = lifecycleModule(name => imports[name]);
  const deliver = async (body, { valid = true, headers = {}, settings = env } = {}) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const signature = valid ? await hmacHex("SHA-256", env.CONNECTOR_SENTRY_CLIENT_SECRET, raw) : "invalid";
    return handleSentryInstallationDelivery(settings, new Request("https://hub.test/api/connectors/sentry/events", {
      method: "POST", body: raw, headers: { "sentry-hook-signature": signature, ...headers },
    }));
  };
  return { retired, deliver, fail: error => { failure = error; } };
}
const delivery = { action: "deleted", installation: { uuid: installationId }, actor: { email: "private-profile" },
  data: { installation: { uuid: installationId, code: "private-code", app: {
    uuid: env.CONNECTOR_SENTRY_APP_UUID, slug: env.CONNECTOR_SENTRY_APP_SLUG } } } };

test("Sentry lifecycle uses only signed identity and commits retirement before ACK", async () => {
  const run = lifecycle();
  assert.equal((await run.deliver(delivery, { valid: false })).status, 401);
  assert.equal(run.retired.length, 0);
  assert.equal((await run.deliver(delivery, { headers: { "sentry-hook-resource": "issue", "sentry-hook-timestamp": "1" } })).status, 204);
  assert.equal(run.retired.length, 1);
  assert.equal(run.retired[0].installationId, installationId);
  assert.equal(run.retired[0].appUuid, env.CONNECTOR_SENTRY_APP_UUID);
  assert.equal(run.retired[0].appClientId, env.CONNECTOR_SENTRY_CLIENT_ID);
  assert.equal(run.retired[0].limit, 50);
  assert.doesNotMatch(JSON.stringify(run.retired), /private-|actor|code/u);
  run.fail(new Error("transaction failed"));
  await assert.rejects(run.deliver(delivery), /transaction failed/u);
});

test("Sentry lifecycle rejects mismatched bodies and does not discard unsupported issue events", async () => {
  const run = lifecycle();
  for (const body of ["bad-json", { ...delivery, installation: { uuid: crypto.randomUUID() } },
    { ...delivery, action: "updated" }, { ...delivery, data: { installation: { ...delivery.data.installation,
      app: { uuid: crypto.randomUUID(), slug: "xmatrix" } } } }]) {
    assert.equal((await run.deliver(body)).status, 400);
  }
  assert.equal((await run.deliver({ action: "created", installation: delivery.installation, data: { issue: {} } },
    { headers: { "sentry-hook-resource": "installation" } })).status, 503);
  assert.equal((await run.deliver({ ...delivery, action: "created" })).status, 204);
  assert.equal((await run.deliver("x".repeat(256 * 1024 + 1))).status, 413);
  assert.equal((await run.deliver(delivery, { settings: {} })).status, 503);
  assert.equal(run.retired.length, 0);
});

test("installation POST is Human-only, explicit, bounded and hides private provider errors", async () => {
  let agent = true;
  let failure;
  const calls = [];
  const imports = {
    "@xmatrix/protocol": { HUB_ROUTES }, "./connectors/http": { ProviderRequestError },
    "./index-shared": { readBoundedRequestBody, requireAuth: async () => ({ agentRun: agent }),
      requireHumanAuth: () => ({ id: "human-admin" }), requestErrorStatus: error => error.status ?? 500 },
    "./connectors/sentry-install-connect": { completeSentryInstallation: async (_, input) => {
      calls.push(input); if (failure) throw failure; return { ok: true };
    } },
  };
  const app = new Hono();
  routeModule(name => imports[name]).registerSentryInstallationRoutes(app);
  const url = HUB_ROUTES.space_app_connection_sentry_install("space-a");
  const valid = { code: "private-code", installationId, organization: "made-by-robot", confirmed: true };
  const post = body => app.request(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }, env);
  assert.equal((await post(valid)).status, 403);
  assert.equal(calls.length, 0);
  agent = false;
  for (const body of ["not-json", { ...valid, confirmed: false }, { ...valid, installationId: "../other" },
    { ...valid, spaceId: "unreviewed-space" }, { ...valid, oauthToken: "caller-grant" }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post("x".repeat(12 * 1024 + 1))).status, 413);
  assert.equal(calls.length, 0);
  const accepted = await post(valid);
  assert.equal(accepted.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await accepted.json(), { ok: true });
  assert.equal(calls[0].spaceId, "space-a");
  assert.equal(calls[0].userId, "human-admin");
  for (const status of [409, 502, 503]) {
    failure = new ProviderRequestError(status, "private-code private-token private-provider");
    const rejected = await post(valid);
    assert.equal(rejected.status, status);
    assert.doesNotMatch(await rejected.text(), /private-/u);
  }
});

test("native confirmation rechecks authority and persists the original attempt only after provider proof", async () => {
  for (const rejectAt of [undefined, "authorize", "begin", "exchange", "put"]) {
    const order = [];
    const proof = { attemptId: crypto.randomUUID(), connectionVersion: 2, credentialVersion: 3, connectionGeneration: 4 };
    const step = name => { order.push(name); if (name === rejectAt) throw new ProviderRequestError(409, "changed"); };
    const repository = {
      readGenerated: async input => { step("authorize"); assert.equal(input.actorUserId, "admin"); },
      beginSentryInstallation: async input => { step("begin"); assert.equal(input.spaceId, "selected"); return proof; },
      put: async input => {
        step("put"); assert.equal(input.verifiedInstallation, proof);
        assert.equal(input.oauthInstallation.installationId, installationId);
        assert.equal(input.fields.oauthToken, "verified-grant");
        assert.doesNotMatch(JSON.stringify(input), /private-code/u);
      },
    };
    const imports = {
      "./credentials": { connectorCredentialRepository: () => repository, INGRESS_KEY_FIELD: "ingressKey", mintConnectorSecret: () => "ingress" },
      "./sentry-installation": { sentryInstallationClient, exchangeSentryInstallation: async (_, input) => {
        step("exchange"); assert.equal(input.code, "private-code"); return { oauthToken: "verified-grant" };
      } },
      "../app-connectors": { getAppConnectorProvider: () => ({ credentials: [{ id: "oauthToken" }] }) },
      "../apps": { upsertAppConnection: async (_, command) => {
        step("prepare"); assert.equal(command.providerId, "sentry"); assert.equal(command.body.initializeOnly, true);
        assert.doesNotMatch(JSON.stringify(command), /private-code|verified-grant/u); return {};
      } }, "./http": { ProviderRequestError },
    };
    const operation = () => connectModule(name => imports[name]).completeSentryInstallation(env, {
      spaceId: "selected", userId: "admin", code: "private-code", installationId, organization: "made-by-robot", confirmed: true,
    });
    if (rejectAt) await assert.rejects(operation(), error => error.status === 409);
    else assert.deepEqual(await operation(), { ok: true });
    const expected = ["authorize", "prepare", "begin", "exchange", "put"];
    assert.deepEqual(order, rejectAt ? expected.slice(0, expected.indexOf(rejectAt) + 1) : expected);
  }
});
