import assert from "node:assert/strict";
import test from "node:test";
import * as protocol from "@xmatrix/protocol";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

const manifest = protocol.APP_CONNECTOR_PROVIDER_MANIFESTS.find(p => p.id === "appstoreconnect");

async function scopeWith(connections, checkConnection = async () => { throw new Error("only Space admins check connections"); }) {
  const { commandScope } = await loadCommonJsSourceModule(new URL("../src/connectors/command-support.ts", import.meta.url), name => ({
    "@xmatrix/protocol": protocol,
    "../spaces": { getChannel: async () => ({ channel: { spaceId: "s" } }) },
    "../apps": { usableAppConnections: async () => connections },
  })[name] ?? {});
  return commandScope(manifest, { env: {}, channelId: "c", actorUserId: "u" }, checkConnection);
}

// A blocked command tells the reader where to reconnect, not only that the app is not connected.
test("a blocked command names how to bring its app back", async () => {
  assert.equal(await scopeWith([]), "connect App Store Connect to this Space first");
  assert.equal(await scopeWith([{ id: "s:appstoreconnect", providerId: "appstoreconnect", status: "disconnected" }]),
    "App Store Connect is disconnected in this Space; reconnect it in Apps → App Store Connect");
  assert.equal(await scopeWith([{ id: "s:appstoreconnect", providerId: "appstoreconnect", status: "error" }]),
    "App Store Connect needs attention in this Space; check it in Apps → App Store Connect");
  assert.deepEqual(await scopeWith([{ id: "s:appstoreconnect", providerId: "appstoreconnect", status: "configured" }]),
    { principal: { kind: "user", id: "u" }, spaceId: "s", connectionId: "s:appstoreconnect" });
});

// The recorded failure may be over; a command finds out instead of sending a person to press Check again.
test("a command on a connection whose last check failed checks again, and runs when the check now passes", async () => {
  const failed = [{ id: "s:appstoreconnect", providerId: "appstoreconnect", status: "error" }];
  const calls = [];
  assert.deepEqual(await scopeWith(failed, async (_env, input) => { calls.push(input); return { ok: true }; }),
    { principal: { kind: "user", id: "u" }, spaceId: "s", connectionId: "s:appstoreconnect" });
  assert.deepEqual([calls[0].spaceId, calls[0].providerId, calls[0].userId], ["s", "appstoreconnect", "u"]);
  assert.equal(await scopeWith(failed, async () => ({ ok: false, message: "the API key was revoked" })),
    "App Store Connect needs attention in this Space: the API key was revoked; check it in Apps → App Store Connect");
});
