import assert from "node:assert/strict";
import test from "node:test";
import { RegistrationAccessError } from "@xmatrix/db";
import { dispatchRegistrationLaunchAnyway } from "../src/registration-launch-dispatch.ts";

const env = { RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL: { idFromName: name => name,
  get: () => ({ fetch: async () => Response.json({ ok: true }) }) } };
const input = { env, channelId: "c", messageId: "m", body: "Correction: the @claude in my heading", actorUserId: "u", sourceMention: "@claude" };

test("launch anyway prepares only the named summon under one stable command", async () => {
  const launches = [];
  const launch = async (request) => {
    launches.push(request);
    return { prepared: [{ launchId: "launch:1" }], rejected: [] };
  };
  const first = await dispatchRegistrationLaunchAnyway(input, { launch });
  await dispatchRegistrationLaunchAnyway(input, { launch });
  assert.deepEqual(first.prepared, [{ launchId: "launch:1" }]);
  assert.equal(launches[0].forceMention, "@claude");
  assert.equal(launches[0].body, input.body);
  assert.equal(launches[0].commandId, launches[1].commandId, "a repeated press recovers the same launch");
  assert.match(launches[0].commandId, /^registration-launch-anyway:m:/);
});

test("a refused override starts nothing", async () => {
  const refused = await dispatchRegistrationLaunchAnyway(input, {
    launch: async () => ({ prepared: [], rejected: [{ code: "invocation_source_unavailable" }] }) });
  assert.deepEqual(refused.prepared, []);
  assert.equal(refused.rejected[0].code, "invocation_source_unavailable");
});

test("a refused dispatch keeps its code and status", async () => {
  const error = await dispatchRegistrationLaunchAnyway(input, {
    launch: async () => { throw new RegistrationAccessError("registration_not_found", 404); } }).catch(failure => failure);
  assert.equal(error.code, "registration_not_found");
  assert.equal(error.status, 404);
});
