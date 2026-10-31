import assert from "node:assert/strict";
import test from "node:test";

import * as machine from "../src/runtime-transport/machine-daemon-port.ts";
import { CLI_RELEASE_FEEDS, fetchCliChannelVersion, noticeCliReleases, parseCliReleaseNotice }
  from "../src/cli-release-notice.ts";
import { RELAY_RUNTIME_CLI_RELEASE_NOTICE_PATH } from "../src/runtime-transport/relay-runtime-product-adapter.ts";
import { FakeSocket } from "./support/runtime-transport.mjs";

const principalFor = (machineId) => Object.freeze({
  ownerUserId: "user-1", ownerEmail: "owner@example.test", machineId, hostId: "host-1",
});

function transport() {
  return new machine.MachineDaemonRuntimeTransport({
    capabilities: new Set(machine.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    async authenticate(message) {
      const principal = principalFor(message.machineId);
      return { principal, connected: { type: "machine_daemon_connected", connectionEpoch: 1, daemon: {
        id: `daemon-${message.machineId}`, userId: principal.ownerUserId, email: principal.ownerEmail,
        machineId: principal.machineId, hostId: principal.hostId, name: "Workstation", status: "online",
        capabilities: [], metadata: {}, createdAt: "2026-10-31T00:00:00.000Z",
        updatedAt: "2026-10-31T00:00:00.000Z", lastSeenAt: "2026-10-31T00:00:00.000Z" } } };
    },
    async refresh(token) { throw new Error(`unexpected refresh ${token}`); },
    async execute() { return undefined; },
    async connected() {},
    async disconnected() {},
  });
}

async function connect(runtime, machineId, version, capabilities = ["machine_cli_release_v1"]) {
  const socket = new FakeSocket();
  runtime.accept(socket);
  await runtime.handleFrame(socket, JSON.stringify({
    type: "machine_daemon_connect", requestId: `connect-${machineId}`, token: "token", displayName: "Workstation",
    machineId, hostId: "host-1", clientVersion: version, protocolVersion: 2, capabilities,
    machineMetadata: { xmatrixDaemonVersion: version },
  }));
  return socket;
}

const notices = (socket) => socket.sent.filter((frame) => frame.type === "machine_cli_release");

test("a cell pushes a release only to capable daemons behind it on its own channel", async () => {
  const runtime = transport();
  const behind = await connect(runtime, "behind", "2.2.0");
  const current = await connect(runtime, "current", "2.3.0");
  const beta = await connect(runtime, "beta", "2.2.1-beta.19");
  const incapable = await connect(runtime, "incapable", "2.1.0", []);

  const stable = { type: "machine_cli_release", channel: "stable", version: "2.3.0" };
  assert.equal(await runtime.noticeCliRelease(stable), 1);
  assert.deepEqual(notices(behind), [stable]);
  assert.deepEqual(notices(current), []);
  assert.deepEqual(notices(beta), []);
  assert.deepEqual(notices(incapable), []);

  const dev = { type: "machine_cli_release", channel: "dev", version: "2.2.1-beta.20" };
  assert.equal(await runtime.noticeCliRelease(dev), 1);
  assert.deepEqual(notices(beta), [dev]);
  assert.equal(notices(behind).length, 1);
});

test("a cell accepts only a notice whose version belongs to its channel", () => {
  assert.deepEqual(parseCliReleaseNotice({ type: "machine_cli_release", channel: "dev", version: "2.2.1-beta.20" }),
    { type: "machine_cli_release", channel: "dev", version: "2.2.1-beta.20" });
  assert.equal(parseCliReleaseNotice({ type: "machine_cli_release", channel: "stable", version: "2.2.1-beta.20" }), undefined);
  assert.equal(parseCliReleaseNotice({ type: "machine_cli_release", channel: "nightly", version: "2.3.0" }), undefined);
  assert.equal(parseCliReleaseNotice({ type: "other", channel: "stable", version: "2.3.0" }), undefined);
  assert.equal(parseCliReleaseNotice(null), undefined);
});

test("a channel's feed must name a release of that channel", async () => {
  const feed = (body, status = 200) => async (url) => {
    assert.ok(Object.values(CLI_RELEASE_FEEDS).includes(url));
    return new Response(JSON.stringify(body), { status });
  };
  assert.equal(await fetchCliChannelVersion("stable", feed({ version: "2.3.0" })), "2.3.0");
  await assert.rejects(fetchCliChannelVersion("stable", feed({ version: "2.3.0-beta.1" })), /names no stable release/);
  await assert.rejects(fetchCliChannelVersion("dev", feed({}, 503)), /answered 503/);
});

test("a pass tells the cells of owners behind each channel and fails loudly on any failure", async () => {
  const told = [];
  const cell = (name, answer) => ({ async fetch(request) {
    assert.equal(new URL(request.url).pathname, RELAY_RUNTIME_CLI_RELEASE_NOTICE_PATH);
    told.push([name, await request.json()]);
    return answer();
  } });
  const result = await noticeCliReleases({}, {
    latest: async (channel) => (channel === "stable" ? "2.3.0" : "2.2.1-beta.20"),
    owners: async (notice) => (notice.channel === "stable" ? ["a", "b"] : []),
    cells: (owners) => owners.map((owner) => cell(owner, () => Response.json({ told: 1 }))),
  });
  assert.deepEqual(result, { told: 2 });
  assert.deepEqual(told.map(([name, notice]) => [name, notice.channel, notice.version]),
    [["a", "stable", "2.3.0"], ["b", "stable", "2.3.0"]]);

  // A cell still on an earlier release is skipped until it restarts; any other failure is reported.
  const rollout = await noticeCliReleases({}, {
    latest: async () => { throw new Error("unused"); },
    owners: async () => [],
  }).catch((error) => error);
  assert.match(rollout.message, /stable: unused; dev: unused/);
  await assert.rejects(noticeCliReleases({}, {
    latest: async (channel) => (channel === "stable" ? "2.3.0" : "2.2.1-beta.20"),
    owners: async () => ["a"],
    cells: () => [
      cell("old", () => Response.json({ error: "Not found", workerVersion: "earlier" }, { status: 404 })),
      cell("broken", () => Response.json({ error: "boom" }, { status: 500 })),
    ],
  }), /stable: cell answered 500; dev: cell answered 500/);
});
