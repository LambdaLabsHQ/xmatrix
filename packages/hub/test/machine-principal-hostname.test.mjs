import assert from "node:assert/strict";
import test from "node:test";
import { decodeJwt, SignJWT } from "jose";
import { signAgentRunToken, verifyAuthToken } from "../src/auth.ts";
import { machineDaemonCommandPrincipal, signMachineDaemonCredential, verifyMachineDaemonCredential } from "../src/connections/machine-daemon/auth.ts";

import { liveRunIsAdmitted, LIVE_RUN_ROUTED_FIELDS } from "../src/live-run-admission.ts";

const env = { BETTER_AUTH_SECRET: "test-machine-identity-signing-secret" };
const principal = { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "machine:one", hostId: "old-host", hostName: "old-host" };

test("new Machine credentials contain only owner and Machine scope, and legacy claims remain readable", async () => {
  const token = await signMachineDaemonCredential(env, principal);
  const claims = decodeJwt(token).xmatrixMachineDaemon;
  assert.deepEqual(claims, { ownerUserId: principal.ownerUserId, ownerEmail: principal.ownerEmail, machineId: principal.machineId });
  const verified = await verifyMachineDaemonCredential(token, env);
  assert.equal(verified.hostId, "");
  assert.equal(machineDaemonCommandPrincipal(verified).id, "machine-daemon:owner:machine:one");
  const legacy = await new SignJWT({ xmatrixMachineDaemon: principal })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("xmatrix-hub-machine-control").setAudience("xmatrix-machine-daemon")
    .setIssuedAt().setExpirationTime("30m")
    .sign(new TextEncoder().encode(`xmatrix-machine-daemon\0${env.BETTER_AUTH_SECRET}`));
  assert.equal((await verifyMachineDaemonCredential(legacy, env)).machineId, principal.machineId);
  assert.equal(machineDaemonCommandPrincipal(await verifyMachineDaemonCredential(legacy, env)).id,
    machineDaemonCommandPrincipal(verified).id);
  await assert.rejects(verifyMachineDaemonCredential(`${token.slice(0, -5)}xxxxx`, env), /Invalid/);
});

test("Run credentials omit hostname while retaining their exact execution and permission scope", async () => {
  const scope = { agentId: "instance:one", agentName: "codex", runId: "run:one", executionKey: "execution:one",
    instanceId: "instance:one", spaceId: "space:one", channelId: "channel:one", machineId: "machine:one",
    hostId: "old-host", permissions: [], runKind: "channel-instance", channelWriteAllowed: true };
  const token = await signAgentRunToken(env, { id: "owner", email: principal.ownerEmail }, scope);
  const claims = decodeJwt(token).xmatrixAgentRun;
  assert.equal(Object.hasOwn(claims, "hostId"), false);
  assert.equal(claims.executionKey, scope.executionKey);
  assert.equal(claims.machineId, scope.machineId);
  const user = await verifyAuthToken(token, env);
  assert.equal(user.agentRun.hostId, "");
  assert.equal(user.agentRun.runId, scope.runId);
  assert.equal(user.agentRun.instanceId, scope.instanceId);
  assert.equal(user.agentRun.ownerUserId, "owner");
  assert.deepEqual(user.agentRun.permissions, []);
});


test("live Run scope is unchanged by hostname or missing hostname, and refuses a different Machine or execution", () => {
  const snapshot = { agentId: "instance", channelId: "channel", executionKey: "execution", status: "running", machineId: "machine:one", hostId: "old-host" };
  const proof = { ...snapshot, hostId: "new-host" };
  assert.equal(liveRunIsAdmitted(snapshot, proof, LIVE_RUN_ROUTED_FIELDS), true);
  assert.equal(liveRunIsAdmitted(snapshot, { ...proof, hostId: undefined }, LIVE_RUN_ROUTED_FIELDS), true);
  for (const change of [{ machineId: "machine:other" }, { executionKey: "other" }, { agentId: "other" }, { channelId: "other" }]) {
    assert.equal(liveRunIsAdmitted(snapshot, { ...proof, ...change }, LIVE_RUN_ROUTED_FIELDS), false);
  }
});
