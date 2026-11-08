import assert from "node:assert/strict";
import test from "node:test";

import * as machine from "../src/runtime-transport/machine-daemon-port.ts";
import { CLI_RELEASE_FEEDS, fetchCliChannelVersion, noticeCliReleases, parseCliReleaseNotice,
  readCliReleaseFeeds } from "../src/cli-release-notice.ts";
import { RELAY_RUNTIME_CLI_RELEASE_NOTICE_PATH } from "../src/runtime-transport/relay-runtime-product-adapter.ts";
import { cliReleaseNoticeEvidence } from "../src/cli-release-notice-failure.ts";
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
  await assert.rejects(fetchCliChannelVersion("stable", feed({ version: "2.3.0-beta.1" })),
    error => /names no stable release/.test(error.errors[0].cause.message));
  await assert.rejects(fetchCliChannelVersion("dev", feed({}, 503)),
    error => /answered 503/.test(error.errors[0].cause.message));
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
  assert.deepEqual(rollout.errors.map(error => [error.evidence.channel, error.cause.message]),
    [["stable", "unused"], ["dev", "unused"]]);
  await assert.rejects(noticeCliReleases({}, {
    latest: async (channel) => (channel === "stable" ? "2.3.0" : "2.2.1-beta.20"),
    owners: async () => ["a"],
    cells: () => [
      cell("old", () => Response.json({ error: "Not found", workerVersion: "earlier" }, { status: 404 })),
      cell("broken", () => Response.json({ error: "boom" }, { status: 500 })),
    ],
  }), error => {
    assert.deepEqual(cliReleaseNoticeEvidence(error).map(({ channel, phase, responseStatus }) =>
      ({ channel, phase, responseStatus })), [
      { channel: "stable", phase: "cell_contract", responseStatus: 500 },
      { channel: "dev", phase: "cell_contract", responseStatus: 500 },
    ]);
    return true;
  });
});

// The feed is a read, so one lost response can recover before any owner is
// told. Existing channel/version tests never exercised transport recovery.
test("a feed retries a lost header or body once with a fresh five-second deadline", async t => {
  const signals = [];
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    assert.equal(milliseconds, 5000);
    const controller = new AbortController();
    signals.push(controller.signal);
    return controller.signal;
  });
  for (const phase of ["headers", "body"]) {
    let calls = 0;
    const result = await fetchCliChannelVersion("dev", async (_url, init) => {
      assert.equal(init.signal.aborted, false);
      if (++calls === 1) {
        const timeout = new DOMException("timed out", "TimeoutError");
        if (phase === "headers") throw timeout;
        return new Response(new ReadableStream({ start(controller) { controller.error(timeout); } }));
      }
      return Response.json({ version: "2.3.1-beta.1" });
    });
    assert.equal(result, "2.3.1-beta.1");
    assert.equal(calls, 2);
  }
  assert.equal(new Set(signals).size, 4);
});

test("two lost feed reads retain both causes and never start a third attempt", async () => {
  const causes = [new DOMException("first timeout", "TimeoutError"), new TypeError("second transport failure")];
  let calls = 0;
  await assert.rejects(fetchCliChannelVersion("dev", async () => { throw causes[calls++]; }), error => {
    assert.deepEqual(error.errors.map(failure => failure.cause), causes);
    assert.deepEqual(cliReleaseNoticeEvidence(error).map(({ attempt, phase }) => [attempt, phase]),
      [[1, "feed_headers"], [2, "feed_headers"]]);
    return true;
  });
  assert.equal(calls, 2);
});

// HUB-BX: a feed started beside the cron's other header-waits ran to 15s.
// Both feeds settle before the caller can open those connections, and a pass
// that already has them does not fetch again.
test("both release feeds settle before another connection can open", async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = readCliReleaseFeeds(async (url) => {
    assert.ok(Object.values(CLI_RELEASE_FEEDS).includes(url));
    started += 1;
    await gate;
    return Response.json({ version: url.endsWith("/dev") ? "2.3.1-beta.1" : "2.3.0" });
  });
  await Promise.resolve();
  assert.equal(started, 2);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  const latest = await pending;
  assert.equal(await latest("stable"), "2.3.0");
  assert.equal(await latest("dev"), "2.3.1-beta.1");
  assert.equal(started, 2);

  const result = await noticeCliReleases({}, { latest, owners: async () => [] });
  assert.deepEqual(result, { told: 0 });
  assert.equal(started, 2);
});

test("a lost feed stays failed after the reads settle and is not fetched again", async () => {
  let calls = 0;
  const latest = await readCliReleaseFeeds(async () => {
    calls += 1;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  assert.equal(calls, 4);
  for (const channel of ["stable", "dev"]) {
    await assert.rejects(latest(channel), (error) => {
      assert.deepEqual(cliReleaseNoticeEvidence(error).map(({ attempt, phase }) => [attempt, phase]),
        [[1, "feed_headers"], [2, "feed_headers"]]);
      return true;
    });
  }
  assert.equal(calls, 4);
});

test("invalid, oversized and HTTP failure feeds do not retry or name a release", async () => {
  for (const response of [() => new Response("{broken"), () => Response.json(null),
    () => Response.json({ version: "2.3.0" }), () => new Response("x".repeat(65537)),
    () => new Response("unavailable", { status: 503 })]) {
    let calls = 0;
    await assert.rejects(fetchCliChannelVersion("dev", async () => { calls++; return response(); }));
    assert.equal(calls, 1);
  }
});

test("a requested update check goes only to that Machine's daemon, and only if it can check", async () => {
  const runtime = transport();
  const capable = await connect(runtime, "capable", "2.3.1", ["machine_cli_release_v1", "machine_cli_update_check_v1"]);
  const other = await connect(runtime, "other", "2.3.1", ["machine_cli_release_v1", "machine_cli_update_check_v1"]);
  const old = await connect(runtime, "old", "2.2.0");
  const checks = (socket) => socket.sent.filter((frame) => frame.type === "machine_cli_update_check");
  const route = (machineId) => ({ ownerUserId: "user-1", machineId, hostId: "host-1" });

  assert.equal(await runtime.checkCliUpdate(route("capable"), "cli-update:1"), true);
  assert.deepEqual(checks(capable), [{ type: "machine_cli_update_check", requestId: "cli-update:1" }]);
  assert.deepEqual(checks(other), []);
  // A daemon that never said it checks on request is not asked, nor is a Machine with no live socket.
  assert.equal(await runtime.checkCliUpdate(route("old"), "cli-update:2"), false);
  assert.deepEqual(checks(old), []);
  assert.equal(await runtime.checkCliUpdate(route("missing"), "cli-update:3"), false);
});
