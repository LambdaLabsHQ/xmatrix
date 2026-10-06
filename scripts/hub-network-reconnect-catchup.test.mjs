import assert from "node:assert/strict";
import test from "node:test";

import {
  channelMessageFromFrame,
  cleanupSyntheticChannel,
  createSyntheticChannel,
  humanConnectFrame,
  postJsonWithRetry,
  relayUrl,
  retryJsonRequest,
  validateSeededHistory,
  verifyProductAttachmentRoundTrip,
} from "./hub-network-e2e/run-reconnect-catchup.mjs";

const immediateRetries = { retryDelayMs: 1, delayImpl: async () => {} };
const syntheticChannel = { hubUrl: "https://hub.example.com", token: "token", channelId: "channel-1" };

function catalogResponse(empty, channelName) {
  return Response.json({
    channels: empty ? [] : [{ id: "channel-winner", name: channelName, archivedAt: null }],
  });
}

function assertCreationRequests(calls, postCount) {
  assert.deepEqual(calls.map(({ path, options, method }) => ({ path, method: method ?? options.method })),
    [...Array.from({ length: postCount }, () => ({ path: "/api/channels", method: "POST" })),
      ...Array.from({ length: 2 }, () => ({ path: "/api/channels", method: "GET" }))]);
}

async function assertAuthorizationNotRetried(invoke) {
  let attempts = 0;
  await assert.rejects(invoke(async () => {
    attempts += 1;
    return Response.json({ error: "forbidden" }, { status: 403 });
  }), /forbidden/u);
  assert.equal(attempts, 1);
}

test("synthetic Human client uses the canonical Human WebSocket endpoint", () => {
  for (const [hubUrl, expectedOrigin] of [
    ["https://xmatrix-hub.test.xmatrix.sh", "wss://xmatrix-hub.test.xmatrix.sh"],
    ["http://127.0.0.1:8787", "ws://127.0.0.1:8787"],
  ]) {
    const url = new URL(relayUrl(hubUrl));
    assert.equal(url.origin, expectedOrigin);
    assert.equal(url.pathname, "/ws/humans");
    assert.equal(url.searchParams.get("x-xmatrix-client-component"), "cli");
    assert.match(url.searchParams.get("x-xmatrix-client-version"), /^\d+\.\d+\.\d+$/u);
    assert.equal(url.searchParams.get("x-xmatrix-client-protocol"), "2");
  }
});

test("synthetic Human client uses the current handshake and live message envelope", () => {
  const connect = humanConnectFrame("test-token");
  assert.equal(connect.type, "human_connect");
  assert.equal(connect.token, "test-token");
  assert.equal(connect.device.client, "cli");
  assert.match(connect.device.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(Number.isSafeInteger(connect.device.protocolVersion), true);
  const message = {
    messageId: "message-1",
    channelId: "channel-1",
    sequence: 2,
    attachments: [{ id: "attachment-1" }],
  };
  assert.equal(channelMessageFromFrame({
    type: "channel_message_received",
    message,
  }, "channel-1"), message);
  assert.equal(channelMessageFromFrame({
    type: "channel_message_received",
    message,
  }, "another-channel"), null);
});

test("seeded history includes the attachment message when attachment smoke is enabled", () => {
  const expected = [
    { messageId: "baseline", sequence: 1 },
    { messageId: "attachment", sequence: 2 },
  ];

  assert.doesNotThrow(() => validateSeededHistory(expected, expected, 2));
  assert.throws(
    () => validateSeededHistory(expected.slice(0, 1), expected, 1),
    /Expected values to be strictly deep-equal/u,
  );
});

test("attachment smoke reads the exact uploaded bytes through product media", async () => {
  const expectedBytes = Buffer.from("next-m0-r2-roundtrip");
  const expectedContentHash = "a".repeat(64);
  const calls = [];
  const result = await verifyProductAttachmentRoundTrip({
    hubUrl: "https://hub.example.com",
    token: "secret-token",
    channelId: "channel-1",
    messageId: "message-1",
    attachmentId: "attachment-1",
    expectedBytes,
    expectedContentHash,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(expectedBytes, {
        status: 200,
        headers: {
          "x-xmatrix-attachment-id": "attachment-1",
          "x-xmatrix-content-hash": expectedContentHash,
        },
      });
    },
  });

  assert.deepEqual(result, {
    encodedBytes: expectedBytes.length,
    contentHash: expectedContentHash,
  });
  assert.equal(
    calls[0].url,
    "https://hub.example.com/api/relay-v2/message-attachments/product-media",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    channelId: "channel-1",
    messageId: "message-1",
    attachmentId: "attachment-1",
  });
  assert.equal(calls[0].init.headers.authorization, "Bearer secret-token");
});

test("synthetic Channel cleanup archives before permanent deletion", async () => {
  const calls = [];
  await cleanupSyntheticChannel({
    hubUrl: "https://hub.example.com",
    token: "token",
    channelId: "channel/with spaces",
    fetchJsonImpl: async (hubUrl, token, path, options) => {
      calls.push({ hubUrl, token, path, options });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    delayImpl: async () => {},
  });

  assert.deepEqual(calls, [
    {
      hubUrl: "https://hub.example.com",
      token: "token",
      path: "/api/channels/channel%2Fwith%20spaces/archive",
      options: { method: "POST", body: "{}" },
    },
    {
      hubUrl: "https://hub.example.com",
      token: "token",
      path: "/api/channels/channel%2Fwith%20spaces",
      options: { method: "DELETE" },
    },
  ]);
});

test("idempotent JSON writes retry the exact encoded request", async () => {
  const calls = [];
  const body = {
    body: "offline message 1",
    clientMessageId: "message-1",
  };
  const result = await postJsonWithRetry({
    hubUrl: "https://hub.example.com",
    token: "token",
    path: "/api/channels/channel-1/messages",
    body,
    headers: { "x-xmatrix-idempotency-key": "request-1" },
    label: "Offline message 1 append",
    fetchJsonImpl: async (hubUrl, token, path, options) => {
      calls.push({ hubUrl, token, path, options });
      if (calls.length === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ message: { messageId: "message-1" } }), {
        status: 200,
      });
    },
    ...immediateRetries,
  });

  assert.equal(result.message.messageId, "message-1");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].options.body, JSON.stringify(body));
  assert.deepEqual(calls[0].options.headers, { "x-xmatrix-idempotency-key": "request-1" });
});

test("synthetic Channel creation recovers a committed winner after a lost response", async () => {
  const calls = [];
  const channelName = "hub-network-e2e-123";
  const result = await createSyntheticChannel({
    hubUrl: "https://hub.example.com",
    token: "token",
    name: channelName,
    idempotencyKey: "create-channel-1",
    fetchJsonImpl: async (hubUrl, token, path, options) => {
      calls.push({ hubUrl, token, path, options });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: "projection unavailable" }), { status: 503 });
      }
      if (calls.length === 2) {
        return new Response(JSON.stringify({
          error: "active sibling channel name already exists",
          code: "channel_name_conflict",
          retryable: false,
        }), { status: 409 });
      }
      return catalogResponse(calls.length === 3, channelName);
    },
    ...immediateRetries,
  });

  assert.equal(result.channel.id, "channel-winner");
  assert.equal(result.recoveredAfterConflict, true);
  assert.equal(calls.length, 4);
  assertCreationRequests(calls, 2);
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.deepEqual(calls[0].options.headers, { "x-xmatrix-idempotency-key": "create-channel-1" });
  assert.deepEqual(calls[0].options.headers, calls[1].options.headers);
});

test("synthetic Channel creation recovers after exhausted retryable responses", async () => {
  const calls = [];
  const channelName = "hub-network-e2e-500";
  const result = await createSyntheticChannel({
    hubUrl: "https://hub.example.com",
    token: "token",
    name: channelName,
    idempotencyKey: "create-channel-500",
    fetchJsonImpl: async (_hubUrl, _token, path, options) => {
      calls.push({ path, method: options.method });
      if (options.method === "POST") {
        return new Response(JSON.stringify({
          error: "retryable create failure",
          code: "internal_error",
          retryable: true,
        }), { status: 500 });
      }
      return catalogResponse(calls.length === 4, channelName);
    },
    ...immediateRetries,
  });

  assert.equal(result.channel.id, "channel-winner");
  assert.equal(result.recoveredAfterCreateError, true);
  assert.equal(result.recoveredAfterConflict, false);
  assertCreationRequests(calls, 3);
});

test("synthetic Channel creation preserves an exhausted error without a committed winner", async () => {
  await assert.rejects(
    createSyntheticChannel({
      hubUrl: "https://hub.example.com",
      token: "token",
      name: "hub-network-e2e-missing",
      attempts: 2,
      catalogAttempts: 2,
      fetchJsonImpl: async (_hubUrl, _token, _path, options) =>
        options.method === "POST"
          ? new Response(JSON.stringify({
            error: "retryable create failure",
            code: "internal_error",
            retryable: true,
          }), { status: 500 })
          : new Response(JSON.stringify({ channels: [] }), { status: 200 }),
      ...immediateRetries,
    }),
    /retryable create failure/u,
  );
});

test("synthetic Channel creation does not recover authorization failures", async () => {
  await assertAuthorizationNotRetried((fetchJsonImpl) => createSyntheticChannel({ hubUrl: "https://hub.example.com", token: "token", fetchJsonImpl, ...immediateRetries }));
});

test("JSON request retries transient statuses but not authorization failures", async () => {
  const statuses = [503, 429, 200];
  const delays = [];
  const result = await retryJsonRequest({
    label: "Synthetic read",
    request: async () => new Response(JSON.stringify({ ok: true }), {
      status: statuses.shift(),
    }),
    retryDelayMs: 10,
    delayImpl: async (delayMs) => delays.push(delayMs),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(delays, [10, 20]);

  await assertAuthorizationNotRetried((request) => retryJsonRequest({
    label: "Synthetic read", request, ...immediateRetries,
  }));
});

async function recordCleanup(request) {
  const calls = [];
  const result = await cleanupSyntheticChannel({
    ...syntheticChannel,
    fetchJsonImpl: async (_hubUrl, _token, path, options) => {
      calls.push({ path, method: options.method });
      return await request(path, options) ?? new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    ...immediateRetries,
  });
  return { calls, result };
}

function assertCleanupRequests(calls, methods) {
  assert.deepEqual(calls, methods.map((method) => ({
    path: `/api/channels/channel-1${method === "POST" ? "/archive" : ""}`,
    method,
  })));
}

test("synthetic Channel cleanup converges after lost archive and delete responses", async () => {
  let archiveAttempts = 0;
  let deleteAttempts = 0;
  const { calls, result } = await recordCleanup(async (_path, options) => {
      if (options.method === "POST" && archiveAttempts++ === 0) {
        throw new TypeError("fetch failed");
      }
      if (options.method === "DELETE" && deleteAttempts++ === 0) {
        throw new TypeError("fetch failed");
      }
      if (options.method === "DELETE") {
        return new Response(JSON.stringify({ error: "Channel not found" }), { status: 404 });
      }
  });

  assertCleanupRequests(calls, ["POST", "POST", "DELETE", "DELETE"]);
  assert.deepEqual(result, { ok: true, alreadyGone: true });
});

test("synthetic Channel cleanup defers deletion of a migrated family root", async () => {
  const { calls, result } = await recordCleanup(async (_path, options) => {
      if (options.method === "DELETE") {
        return new Response(JSON.stringify({
          error: "A migrated Channel family root cannot be removed in place",
          code: "channel_family_root_removed",
          retryable: false,
        }), { status: 409 });
      }
  });

  assertCleanupRequests(calls, ["POST", "DELETE"]);
  assert.deepEqual(result, {
    ok: true,
    deletionDeferred: true,
    code: "channel_family_root_removed",
  });
});

test("synthetic Channel cleanup still fails on an unrelated conflict", async () => {
  await assert.rejects(
    cleanupSyntheticChannel({
      ...syntheticChannel,
      fetchJsonImpl: async (_hubUrl, _token, _path, options) =>
        options.method === "DELETE"
          ? new Response(JSON.stringify({ error: "version conflict", code: "conflict" }), { status: 409 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ...immediateRetries,
    }),
    /conflict/u,
  );
});

test("synthetic Channel cleanup does not retry authorization failures", async () => {
  await assertAuthorizationNotRetried((fetchJsonImpl) => cleanupSyntheticChannel({ ...syntheticChannel, fetchJsonImpl, ...immediateRetries }));
});

test("synthetic Channel cleanup reports exhausted transport retries", async () => {
  let attempts = 0;
  await assert.rejects(
    cleanupSyntheticChannel({
      ...syntheticChannel,
      fetchJsonImpl: async () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      },
      attempts: 3,
      ...immediateRetries,
    }),
    /Synthetic Channel archive failed after 3 attempts/u,
  );
  assert.equal(attempts, 3);
});
