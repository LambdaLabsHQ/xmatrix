import { recordingRuntimeNamespace } from "./support/runtime-namespace.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RuntimeRouteDirectoryDeliveryError,
  publishRuntimeChannelAgentPresence,
  publishRuntimeChannelMessage,
  publishRuntimeChannelObservableEvent,
  publishRuntimeCommittedEvent,
  runtimeCellsForChannel,
} from "../src/runtime-transport/runtime-route-directory-delivery.ts";

const SCOPE = "channel:route-directory-delivery";
const PAYLOAD = { channelId: SCOPE, changeSeq: 1, event: { type: "test" } };

const runtimeNamespace = (handlers, calls) => recordingRuntimeNamespace(calls, (name, request) => handlers[name](request));

function jsonNamespace(calls, respond) {
  return {
    idFromName: (name) => ({ name }),
    get: () => ({
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.clone().json();
        calls.push({ path: url.pathname, body });
        return respond(url.pathname);
      },
    }),
  };
}

function directoryNamespace(routes, calls, { fanout = false } = {}) {
  return jsonNamespace(calls, (pathname) => {
    if (!pathname.endsWith("/lookup")) return Response.json({ unregistered: 1 });
    if (fanout) return Response.json({ cells: [], routes: [], fanout: true });
    return Response.json({ cells: routes.map((route) => route.cellName), routes });
  });
}

function fanoutNamespace(calls, members = []) {
  return jsonNamespace(calls, (pathname) => pathname.endsWith("/members")
    ? Response.json({ cells: members.map((route) => route.cellName), routes: members })
    : Response.json({ delivered: members.length }));
}

function echoRuntime(names) {
  return Object.fromEntries(names.map((name) => [name, async () => Response.json({ cell: name })]));
}

async function probedCells(env) {
  const cells = await runtimeCellsForChannel(env, SCOPE);
  return Promise.all(cells.map(async (cell) =>
    (await (await cell.fetch(new Request("https://relay-runtime/probe"))).json()).cell));
}

function input({ mode, handlers, routes = [] }) {
  const runtimeCalls = [];
  const directoryCalls = [];
  const waitUntil = [];
  return {
    runtimeCalls,
    directoryCalls,
    waitUntil,
    input: {
      env: {
        RELAY_RUNTIME: runtimeNamespace(handlers, runtimeCalls),
        RELAY_RUNTIME_ROUTE_DIRECTORY: directoryNamespace(routes, directoryCalls),
        XMATRIX_RUNTIME_CELL_MODE: mode,
      },
      scopeId: SCOPE,
      payload: PAYLOAD,
      waitUntil: (task) => waitUntil.push(task),
    },
  };
}

function dualDelivery(handlers) {
  return input({
    mode: "dual",
    routes: [{ cellName: "cell-v1-04", expiresAtMs: 1_700_000_000_000 }],
    handlers: {
      "cell-0": async () => Response.json({ delivered: 1 }),
      ...handlers,
    },
  });
}

test("shadow delivery never reads the directory and preserves one cell-0 fetch", async () => {
  const fixture = input({
    mode: undefined,
    handlers: {
      "cell-0": async () => Response.json({ delivered: 1 }),
    },
  });
  const response = await publishRuntimeCommittedEvent(fixture.input);
  assert.equal(response.status, 200);
  assert.deepEqual(fixture.runtimeCalls.map((call) => call.cell), ["cell-0"]);
  assert.deepEqual(fixture.directoryCalls, []);
  assert.deepEqual(fixture.waitUntil, []);
});

test("dual delivery retries only the overloaded candidate", async () => {
  let candidateAttempts = 0;
  const fixture = dualDelivery({
    "cell-v1-04": async () => {
      candidateAttempts += 1;
      if (candidateAttempts < 3) throw new Error("Durable Object is overloaded. Requests queued for too long.");
      return Response.json({ delivered: 1 });
    },
  });
  await publishRuntimeCommittedEvent(fixture.input);
  assert.equal(candidateAttempts, 3);
  assert.equal(fixture.runtimeCalls.filter((call) => call.cell === "cell-0").length, 1);
  assert.equal(fixture.runtimeCalls.filter((call) => call.cell === "cell-v1-04").length, 3);
  assert.deepEqual(fixture.directoryCalls.map((call) => call.path), ["/internal/runtime-route-directory/lookup"]);
});

test("a rejected candidate never replays a successful cell and never clears its route", async () => {
  const fixture = dualDelivery({
    "cell-v1-04": async () => Response.json({ error: "temporary refusal" }, { status: 503 }),
  });
  await assert.rejects(
    publishRuntimeCommittedEvent(fixture.input),
    RuntimeRouteDirectoryDeliveryError,
  );
  assert.equal(fixture.runtimeCalls.filter((call) => call.cell === "cell-0").length, 1);
  assert.equal(fixture.runtimeCalls.filter((call) => call.cell === "cell-v1-04").length, 1);
  assert.equal(fixture.directoryCalls.length, 1, "a temporary failure never touches the directory");
});

test("Channel observable events fan out once per occupied Runtime cell", async () => {
  const fixture = dualDelivery({
    "cell-0": async () => Response.json({ ok: true, delivered: 0 }),
    "cell-v1-04": async () => Response.json({ ok: true, delivered: 1 }),
  });
  const payload = {
    recipientUserIds: ["reader-b"],
    event: { id: "read-event-1", type: "channel_member_read_updated" },
  };
  const response = await publishRuntimeChannelObservableEvent({
    env: fixture.input.env,
    channelId: SCOPE,
    payload,
    waitUntil: fixture.input.waitUntil,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(fixture.runtimeCalls.map((call) => call.cell).sort(), ["cell-0", "cell-v1-04"]);
  for (const call of fixture.runtimeCalls) {
    assert.equal(new URL(call.request.url).pathname, "/internal/product/channel-observable-event");
    assert.deepEqual(await call.request.json(), payload);
  }
  assert.equal(fixture.directoryCalls.length, 1);
});

test("live fanout from an occupied owner cell does not RPC back into that same object", async () => {
  let localFetches = 0;
  const fixture = input({
    mode: "dual",
    routes: [{ cellName: "user-alice", expiresAtMs: 1_700_000_000_000 }],
    handlers: {
      "cell-0": async () => Response.json({ delivered: 1 }),
      "user-alice": async () => {
        throw new Error("Durable Object queued behind the publishing request");
      },
    },
  });
  const payload = {
    channelId: SCOPE, messageId: "message-1", sequence: 1, body: "hello",
    from: { kind: "agent", label: "grok", userId: "" }, sentAt: "2026-10-05T06:00:00.000Z",
    recipientUserIds: ["reader-b"],
  };
  const response = await publishRuntimeChannelMessage({
    env: fixture.input.env,
    channelId: SCOPE,
    payload,
    waitUntil: fixture.input.waitUntil,
    self: {
      cellName: "user-alice",
      fetch: async (request) => {
        localFetches += 1;
        assert.equal(new URL(request.url).pathname, "/internal/product/channel-message");
        return Response.json({ agent: { delivered: 1 } });
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(localFetches, 1);
  assert.equal(fixture.runtimeCalls.filter((call) => call.cell === "cell-0").length, 1);
  assert.equal(fixture.runtimeCalls.filter((call) => call.cell === "user-alice").length, 0);
});

test("a channel's cells are the single cell plus every owner cell listed for it", async () => {
  const directoryCalls = [];
  const env = {
    RELAY_RUNTIME: runtimeNamespace(echoRuntime(["cell-0", "user-alice"]), []),
    RELAY_RUNTIME_ROUTE_DIRECTORY: directoryNamespace([
      { cellName: "cell-0", expiresAtMs: 1_700_000_000_000 },
      { cellName: "user-alice", expiresAtMs: 1_700_000_000_000 },
    ], directoryCalls),
    XMATRIX_RUNTIME_CELL_MODE: "dual",
  };
  assert.deepEqual(await probedCells(env), ["cell-0", "user-alice"]);
  assert.equal(directoryCalls.length, 1);
});

const presenceOk = async () => Response.json({ ok: true, delivered: 1 });

async function publishPresence({ mode, exceptCell, routes = [], handlers, body = "{}" }) {
  const fixture = input({ mode, routes, handlers });
  await publishRuntimeChannelAgentPresence({
    env: fixture.input.env,
    channelId: SCOPE,
    body,
    exceptCell,
  });
  return fixture;
}

test("agent presence publish skips the cell that already delivered it", async () => {
  const fixture = await publishPresence({
    mode: "dual",
    exceptCell: "user-alice",
    routes: [
      { cellName: "user-alice", expiresAtMs: 1_700_000_000_000 },
      { cellName: "user-bob", expiresAtMs: 1_700_000_000_000 },
    ],
    handlers: {
      "cell-0": presenceOk,
      "user-alice": async () => Response.json({ ok: true, delivered: 0 }),
      "user-bob": presenceOk,
    },
    body: JSON.stringify({ channelId: SCOPE, reason: "update", recipients: [] }),
  });
  assert.deepEqual(fixture.runtimeCalls.map((call) => call.cell).sort(), ["cell-0", "user-bob"]);
  assert.equal(
    fixture.runtimeCalls.every((call) =>
      new URL(call.request.url).pathname === "/internal/product/channel-agent-presence"),
    true,
  );
});

test("fanout delivery is one fanout fetch plus cell-0", async () => {
  const runtimeCalls = [];
  const directoryCalls = [];
  const fanoutCalls = [];
  const env = {
    RELAY_RUNTIME: runtimeNamespace({
      "cell-0": async () => Response.json({ delivered: 1 }),
      "user-alice": async () => {
        throw new Error("publisher must not fetch owner cells");
      },
      "user-bob": async () => {
        throw new Error("publisher must not fetch owner cells");
      },
    }, runtimeCalls),
    RELAY_RUNTIME_ROUTE_DIRECTORY: directoryNamespace([], directoryCalls, { fanout: true }),
    RELAY_RUNTIME_CHANNEL_FANOUT: fanoutNamespace(fanoutCalls),
    XMATRIX_RUNTIME_CELL_MODE: "dual",
  };
  let localFetches = 0;
  const response = await publishRuntimeCommittedEvent({
    env,
    scopeId: SCOPE,
    payload: PAYLOAD,
    waitUntil: () => {},
    self: {
      cellName: "user-alice",
      fetch: async () => {
        localFetches += 1;
        return Response.json({ delivered: 1 });
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(localFetches, 0);
  assert.deepEqual(runtimeCalls.map((call) => call.cell), ["cell-0"]);
  assert.equal(fanoutCalls.length, 1);
  assert.equal(fanoutCalls[0].path, "/internal/runtime-channel-fanout/deliver");
  assert.equal(fanoutCalls[0].body.url, "https://relay-runtime/internal/committed-event");
  assert.equal(fanoutCalls[0].body.exceptCell, "user-alice");
  assert.equal(JSON.parse(fanoutCalls[0].body.body).changeSeq, 1);
});

test("a fanout channel's cells come from the fanout membership", async () => {
  const fanoutCalls = [];
  const members = [
    { cellName: "user-alice", expiresAtMs: 1_700_000_000_000 },
    { cellName: "user-bob", expiresAtMs: 1_700_000_000_000 },
  ];
  const env = {
    RELAY_RUNTIME: runtimeNamespace(echoRuntime(["cell-0", "user-alice", "user-bob"]), []),
    RELAY_RUNTIME_ROUTE_DIRECTORY: directoryNamespace([], [], { fanout: true }),
    RELAY_RUNTIME_CHANNEL_FANOUT: fanoutNamespace(fanoutCalls, members),
    XMATRIX_RUNTIME_CELL_MODE: "dual",
  };
  assert.deepEqual(await probedCells(env), ["cell-0", "user-alice", "user-bob"]);
  assert.deepEqual(fanoutCalls.map((call) => call.path), ["/internal/runtime-channel-fanout/members"]);
});

test("agent presence on a fanout channel skips the publishing cell inside the fanout fetch", async () => {
  const fixture = input({
    mode: "dual",
    handlers: {
      "cell-0": presenceOk,
      "user-alice": async () => {
        throw new Error("publisher must not fetch owner cells");
      },
    },
  });
  const fanoutCalls = [];
  fixture.input.env.RELAY_RUNTIME_ROUTE_DIRECTORY = directoryNamespace([], fixture.directoryCalls, { fanout: true });
  fixture.input.env.RELAY_RUNTIME_CHANNEL_FANOUT = fanoutNamespace(fanoutCalls);
  await publishRuntimeChannelAgentPresence({
    env: fixture.input.env,
    channelId: SCOPE,
    body: JSON.stringify({ channelId: SCOPE, reason: "update", recipients: [] }),
    exceptCell: "user-alice",
  });
  assert.deepEqual(fixture.runtimeCalls.map((call) => call.cell), ["cell-0"]);
  assert.equal(fanoutCalls.length, 1);
  assert.equal(fanoutCalls[0].body.exceptCell, "user-alice");
  assert.equal(fanoutCalls[0].body.url, "https://relay-runtime/internal/product/channel-agent-presence");
});

test("agent presence outside dual routing reaches cell-0 unless that cell published it", async () => {
  const publishedBySingle = await publishPresence({
    mode: undefined,
    exceptCell: "cell-0",
    handlers: { "cell-0": presenceOk },
  });
  assert.deepEqual(publishedBySingle.runtimeCalls, []);
  assert.deepEqual(publishedBySingle.directoryCalls, []);
  const publishedByOwner = await publishPresence({
    mode: undefined,
    exceptCell: "user-alice",
    handlers: { "cell-0": presenceOk },
  });
  assert.deepEqual(publishedByOwner.runtimeCalls.map((call) => call.cell), ["cell-0"]);
  assert.deepEqual(publishedByOwner.directoryCalls, []);
});
