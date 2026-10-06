#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { startTestWorker } from "../e2e-utils/local-worker.mjs";
import { ensureHubTarget, expectJson, fetchJson } from "../e2e-utils/http-json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const hubRoot = join(repoRoot, "packages/hub");
const defaultResultsDir = join(__dirname, "results");
const sourceVersion = JSON.parse(readFileSync(join(repoRoot, "version.json"), "utf8")).version;
const compatibilityPolicy = JSON.parse(readFileSync(
  join(repoRoot, "packages/protocol/src/client-compatibility-policy.json"),
  "utf8",
));
const clientCompatibilityHeaders = Object.freeze({
  "x-xmatrix-client-component": "cli",
  "x-xmatrix-client-version": sourceVersion,
  "x-xmatrix-client-protocol": String(compatibilityPolicy.protocolVersion),
});
const messageAttachmentProductMediaPath =
  "/api/relay-v2/message-attachments/product-media";

function fetchHubJson(hubUrl, token, path, init = {}) {
  return fetchJson(hubUrl, token, path, {
    ...init,
    headers: { ...clientCompatibilityHeaders, ...init.headers },
  });
}

function parseArgs(argv) {
  const args = {
    hubUrl: process.env.HUB_URL || "",
    token: process.env.XMATRIX_TOKEN || "",
    messages: 5,
    resultsDir: defaultResultsDir,
    skipLocalWorker: false,
    cleanup: false,
    exerciseAttachment: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hub-url") args.hubUrl = argv[++i];
    else if (arg === "--token") args.token = argv[++i];
    else if (arg === "--messages") args.messages = Number(argv[++i]);
    else if (arg === "--results-dir") args.resultsDir = argv[++i];
    else if (arg === "--skip-local-worker") args.skipLocalWorker = true;
    else if (arg === "--cleanup") args.cleanup = true;
    else if (arg === "--exercise-attachment") args.exerciseAttachment = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/hub-network-e2e/run-reconnect-catchup.mjs [options]

Options:
  --hub-url <url>          Use an already-running Hub instead of local Worker
  --token <token>          Bearer token for --hub-url mode
  --messages <n>           Number of messages sent while the client is offline
  --skip-local-worker      Fail if --hub-url is not provided
  --cleanup                Delete the synthetic Channel; cleanup failure fails the smoke
  --exercise-attachment    Upload and bind a synthetic R2-backed attachment
  --results-dir <path>     Directory for JSON report
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.messages) || args.messages < 1 || args.messages > 100) {
    throw new Error("--messages must be an integer between 1 and 100");
  }
  return args;
}

export function relayUrl(hubUrl) {
  const parsed = new URL(hubUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws/humans";
  for (const [name, value] of Object.entries(clientCompatibilityHeaders)) {
    parsed.searchParams.set(name, value);
  }
  return parsed.toString();
}

function waitForOpen(ws) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out opening WebSocket")), 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket error before open"));
    }, { once: true });
  });
}

function waitForClose(ws) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolvePromise) => {
    ws.addEventListener("close", () => resolvePromise(), { once: true });
    ws.close();
  });
}

export function humanConnectFrame(token) {
  return {
    type: "human_connect",
    token,
    device: {
      client: "cli",
      label: "hub-network-e2e",
      version: sourceVersion,
      protocolVersion: compatibilityPolicy.protocolVersion,
    },
  };
}

export function channelMessageFromFrame(frame, channelId) {
  if (
    !frame ||
    frame.type !== "channel_message_received" ||
    !frame.message ||
    frame.message.channelId !== channelId
  ) {
    return null;
  }
  return frame.message;
}

async function getHistory(hubUrl, token, channelId, options = {}) {
  const params = new URLSearchParams({ limit: String(options.limit || 50) });
  if (options.afterSequence !== undefined) {
    params.set("afterSequence", String(options.afterSequence));
  }
  const response = await retryJsonRequest({
    label: "Synthetic Channel history read",
    request: () => fetchHubJson(
      hubUrl,
      token,
      `/api/channels/${encodeURIComponent(channelId)}/history?${params.toString()}`
    ),
  });
  return response.messages || [];
}

async function startLocalWorker() {
  const { unstable_dev } = await import("wrangler");
  const token = "hub-network-e2e-token";
  const { worker, hubUrl } = await startTestWorker(unstable_dev, join(hubRoot, "src/index-scoped-authority-test.ts"), {
    config: join(hubRoot, "wrangler.test.toml"),
    persist: false,
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: token,
      XMATRIX_MOCK_AUTH_USER_ID: "hub-network-e2e-user",
      XMATRIX_MOCK_AUTH_EMAIL: "hub-network-e2e@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Hub Network E2E",
    },
  });
  return {
    worker,
    hubUrl,
    token,
  };
}

class SyntheticProtocolClient {
  constructor({ hubUrl, token, channelId }) {
    this.hubUrl = hubUrl;
    this.token = token;
    this.channelId = channelId;
    this.messages = new Map();
    this.lastSequence = 0;
    this.catchUpRuns = [];
    this.ws = null;
  }

  remember(message) {
    this.messages.set(message.messageId, message);
    if (Number.isFinite(message.sequence)) {
      this.lastSequence = Math.max(this.lastSequence, message.sequence);
    }
  }

  async seedFromHistory() {
    const messages = await getHistory(this.hubUrl, this.token, this.channelId, { limit: 50 });
    for (const message of messages) this.remember(message);
    return messages;
  }

  async connect() {
    this.ws = new WebSocket(relayUrl(this.hubUrl));
    await waitForOpen(this.ws);
    const subscribedAt = performance.now();
    const subscribed = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for human_connected")), 5_000);
      this.ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "human_connected") {
          clearTimeout(timer);
          resolvePromise();
          return;
        }
        if (message.type === "error") {
          clearTimeout(timer);
          reject(new Error(`Human WebSocket handshake failed: ${message.message}`));
          return;
        }
        const received = channelMessageFromFrame(message, this.channelId);
        if (received) this.remember(received);
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WebSocket error before human_connected"));
      }, { once: true });
    });
    this.ws.send(JSON.stringify(humanConnectFrame(this.token)));
    await subscribed;
    return performance.now() - subscribedAt;
  }

  async disconnect() {
    if (!this.ws) return;
    await waitForClose(this.ws);
    this.ws = null;
  }

  async catchUp() {
    const afterSequence = this.lastSequence;
    const started = performance.now();
    const messages = await getHistory(this.hubUrl, this.token, this.channelId, {
      limit: 100,
      afterSequence,
    });
    for (const message of messages) this.remember(message);
    const result = {
      afterSequence,
      entryCount: messages.length,
      latencyMs: performance.now() - started,
      lastSequence: this.lastSequence,
    };
    this.catchUpRuns.push(result);
    return result;
  }
}

export function validateSeededHistory(seeded, expectedMessages, lastSequence) {
  assert.deepEqual(
    seeded.map((message) => ({
      messageId: message.messageId,
      sequence: message.sequence,
    })),
    expectedMessages.map((message) => ({
      messageId: message.messageId,
      sequence: message.sequence,
    })),
  );
  assert.equal(lastSequence, expectedMessages.at(-1).sequence);
}

export async function verifyProductAttachmentRoundTrip({
  hubUrl,
  token,
  channelId,
  messageId,
  attachmentId,
  expectedBytes,
  expectedContentHash,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`${hubUrl}${messageAttachmentProductMediaPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...clientCompatibilityHeaders,
    },
    body: JSON.stringify({ channelId, messageId, attachmentId }),
  });
  if (!response.ok) {
    throw new Error(
      `Attachment product-media read failed with ${response.status}: ${await response.text()}`,
    );
  }
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(downloaded, expectedBytes);
  assert.equal(response.headers.get("x-xmatrix-attachment-id"), attachmentId);
  assert.equal(response.headers.get("x-xmatrix-content-hash"), expectedContentHash);
  return { encodedBytes: downloaded.length, contentHash: expectedContentHash };
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

export async function retryJsonRequest({
  label,
  request,
  alreadyGoneIsSuccess = false,
  familyRootRemovalIsDeferred = false,
  attempts = 3,
  retryDelayMs = 1_000,
  expectJsonImpl = expectJson,
  delayImpl = wait,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await request();
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(`${label} failed after ${attempts} attempts`, { cause: error });
      }
      await delayImpl(retryDelayMs * attempt);
      continue;
    }

    if (alreadyGoneIsSuccess && response.status === 404) {
      return { ok: true, alreadyGone: true };
    }
    if (familyRootRemovalIsDeferred && response.status === 409) {
      const body = await response.clone().json().catch(() => null);
      if (body?.code === "channel_family_root_removed") {
        return { ok: true, deletionDeferred: true, code: body.code };
      }
    }
    if (response.ok || !RETRYABLE_HTTP_STATUSES.has(response.status) || attempt === attempts) {
      return await expectJsonImpl(response);
    }

    await delayImpl(retryDelayMs * attempt);
  }
  throw new Error(`${label} failed after ${attempts} attempts`);
}

export async function postJsonWithRetry({
  hubUrl,
  token,
  path,
  body,
  headers,
  label,
  fetchJsonImpl = fetchHubJson,
  ...retryOptions
}) {
  const encodedBody = JSON.stringify(body);
  return await retryJsonRequest({
    label,
    request: () => fetchJsonImpl(hubUrl, token, path, {
      method: "POST",
      ...(headers ? { headers } : {}),
      body: encodedBody,
    }),
    ...retryOptions,
  });
}

export async function createSyntheticChannel({
  hubUrl,
  token,
  name = `hub-network-e2e-${Date.now()}`,
  fetchJsonImpl = fetchHubJson,
  expectJsonImpl = expectJson,
  attempts = 3,
  catalogAttempts = 6,
  retryDelayMs = 1_000,
  delayImpl = wait,
  idempotencyKey = randomUUID(),
}) {
  let created;
  let creationError;
  let fatalCreateResponse = false;
  try {
    created = await postJsonWithRetry({
      hubUrl,
      token,
      path: "/api/channels",
      body: {
        mode: "closed",
        name,
        memberName: "Hub Network E2E",
      },
      headers: { "x-xmatrix-idempotency-key": idempotencyKey },
      label: "Synthetic Channel creation",
      fetchJsonImpl,
      attempts,
      retryDelayMs,
      delayImpl,
      expectJsonImpl: async (response) => {
        if (response.status === 409) {
          const payload = await response.clone().json().catch(() => null);
          if (payload?.code === "channel_name_conflict") {
            return { channelNameConflict: true };
          }
        }
        if (!response.ok && !RETRYABLE_HTTP_STATUSES.has(response.status)) {
          fatalCreateResponse = true;
        }
        return await expectJsonImpl(response);
      },
    });
  } catch (error) {
    if (fatalCreateResponse) throw error;
    creationError = error;
  }
  if (created && !created.channelNameConflict) return created;

  // A retryable response can be lost after Core commits the create. Depending
  // on where the response was lost, retries can exhaust with another 5xx or a
  // sibling-name conflict. In either case, wait for the committed winner's
  // catalog projection so the smoke can continue and clean up that exact row.
  for (let catalogAttempt = 1; catalogAttempt <= catalogAttempts; catalogAttempt += 1) {
    try {
      const catalog = await retryJsonRequest({
        label: "Synthetic Channel creation recovery",
        request: () => fetchJsonImpl(hubUrl, token, "/api/channels", { method: "GET" }),
        attempts,
        retryDelayMs,
        delayImpl,
        expectJsonImpl,
      });
      const channel = Array.isArray(catalog?.channels)
        ? catalog.channels.find((candidate) =>
          candidate?.name === name && !candidate?.archivedAt && candidate?.archived !== true)
        : null;
      if (channel?.id) {
        return {
          channel,
          recoveredAfterConflict: Boolean(created?.channelNameConflict),
          recoveredAfterCreateError: Boolean(creationError),
        };
      }
    } catch (error) {
      if (catalogAttempt === catalogAttempts && !creationError) throw error;
    }
    if (catalogAttempt < catalogAttempts) {
      await delayImpl(retryDelayMs * catalogAttempt);
    }
  }
  if (creationError) throw creationError;
  throw new Error("Synthetic Channel conflict winner is not visible in the catalog");
}

export async function cleanupSyntheticChannel({
  hubUrl,
  token,
  channelId,
  fetchJsonImpl = fetchHubJson,
  expectJsonImpl = expectJson,
  attempts = 3,
  retryDelayMs = 1_000,
  delayImpl = wait,
}) {
  const channelPath = `/api/channels/${encodeURIComponent(channelId)}`;
  await retryJsonRequest({
    label: "Synthetic Channel archive",
    request: () => fetchJsonImpl(hubUrl, token, `${channelPath}/archive`, {
      method: "POST",
      body: "{}",
    }),
    attempts,
    retryDelayMs,
    expectJsonImpl,
    delayImpl,
  });
  // Channels born in a family-authoritative Space cannot yet be deleted in
  // place (the authority refuses with channel_family_root_removed by design; family
  // root retirement lands with the catalog partition program). Archive above
  // is the effective cleanup; the delete is best-effort until then.
  return await retryJsonRequest({
    label: "Synthetic Channel deletion",
    request: () => fetchJsonImpl(hubUrl, token, channelPath, { method: "DELETE" }),
    alreadyGoneIsSuccess: true,
    familyRootRemovalIsDeferred: true,
    attempts,
    retryDelayMs,
    expectJsonImpl,
    delayImpl,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = {
    name: "hub-network-reconnect-catchup",
    startedAt: new Date().toISOString(),
    mode: args.hubUrl ? "remote" : "local-worker",
    steps: [],
  };
  let local = null;
  let channelId = null;
  let primaryError = null;
  const started = performance.now();
  try {
    local = await ensureHubTarget(args, startLocalWorker);
    report.hubUrl = args.hubUrl;

    const channel = await createSyntheticChannel({
      hubUrl: args.hubUrl,
      token: args.token,
    });
    channelId = channel.channel.id;
    report.channelId = channelId;
    report.steps.push({ step: "create-channel", ok: true, channelId });

    const initial = await postJsonWithRetry({
      hubUrl: args.hubUrl,
      token: args.token,
      path: `/api/channels/${encodeURIComponent(channelId)}/messages`,
      body: {
        body: "baseline before disconnect",
        clientMessageId: randomUUID(),
      },
      label: "Baseline message append",
    });
    report.steps.push({
      step: "send-baseline",
      ok: true,
      sequence: initial.message.sequence,
    });
    const expectedSeedMessages = [initial.message];

    if (args.exerciseAttachment) {
      const bytes = Buffer.from(`xmatrix-test-smoke:${randomUUID()}`);
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      const intentId = `intent-${randomUUID()}`;
      const attachmentId = randomUUID();
      const messageId = randomUUID();
      const visibilityScopeId = `channel:${channelId}`;
      const admitted = await postJsonWithRetry({
        hubUrl: args.hubUrl,
        token: args.token,
        path: "/api/relay-v2/private-r2/upload-intents",
        body: {
          requestId: `request-${randomUUID()}`,
          intentId,
          visibilityScopeId,
          contentHash,
          encodedSize: bytes.length,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
        label: "Attachment upload intent",
      });
      await retryJsonRequest({
        label: "Attachment object upload",
        request: () => fetchHubJson(args.hubUrl, args.token, admitted.upload.finalPath, {
          method: "PUT",
          headers: {
            "content-type": "text/plain",
            "content-length": String(bytes.length),
            "x-xmatrix-content-sha256": contentHash,
          },
          body: bytes,
        }),
      });
      await postJsonWithRetry({
        hubUrl: args.hubUrl,
        token: args.token,
        path: "/api/relay-v2/private-r2/blob-refs",
        body: {
          requestId: `ref-${randomUUID()}`,
          intentId,
          refId: attachmentId,
          ownerKind: "message_attachment",
          ownerId: messageId,
          visibilityScopeId,
        },
        label: "Attachment blob reference",
      });
      const attached = await postJsonWithRetry({
        hubUrl: args.hubUrl,
        token: args.token,
        path: `/api/channels/${encodeURIComponent(channelId)}/messages`,
        body: {
          body: "test release attachment",
          clientMessageId: messageId,
          attachments: [{
            attachmentId,
            objectKey: `objects/${contentHash}`,
            contentHash,
            encodedBytes: bytes.length,
            mimeType: "text/plain",
            name: "test-release-smoke.txt",
          }],
        },
        label: "Attachment message append",
      });
      assert.equal(attached.message.attachments?.[0]?.id, attachmentId);
      const roundTrip = await verifyProductAttachmentRoundTrip({
        hubUrl: args.hubUrl,
        token: args.token,
        channelId,
        messageId: attached.message.messageId,
        attachmentId,
        expectedBytes: bytes,
        expectedContentHash: contentHash,
      });
      expectedSeedMessages.push(attached.message);
      report.steps.push({
        step: "attachment-r2-roundtrip",
        ok: true,
        attachmentId,
        encodedBytes: roundTrip.encodedBytes,
        contentHash: roundTrip.contentHash,
      });
    }

    const client = new SyntheticProtocolClient({
      hubUrl: args.hubUrl,
      token: args.token,
      channelId,
    });
    const seeded = await client.seedFromHistory();
    validateSeededHistory(seeded, expectedSeedMessages, client.lastSequence);
    const subscribeLatencyMs = await client.connect();
    await client.disconnect();
    report.steps.push({
      step: "connect-and-drop",
      ok: true,
      subscribeLatencyMs,
      lastSequence: client.lastSequence,
    });

    const offlineMessages = [];
    for (let i = 0; i < args.messages; i += 1) {
      const sent = await postJsonWithRetry({
        hubUrl: args.hubUrl,
        token: args.token,
        path: `/api/channels/${encodeURIComponent(channelId)}/messages`,
        body: {
          body: `offline message ${i + 1}`,
          clientMessageId: randomUUID(),
        },
        label: `Offline message ${i + 1} append`,
      });
      offlineMessages.push(sent.message);
    }
    report.steps.push({
      step: "send-offline-window",
      ok: true,
      count: offlineMessages.length,
      firstSequence: offlineMessages[0].sequence,
      lastSequence: offlineMessages.at(-1).sequence,
    });

    const reconnectLatencyMs = await client.connect();
    const catchUp = await client.catchUp();
    const missing = offlineMessages.filter((message) => !client.messages.has(message.messageId));
    assert.deepEqual(missing, []);
    assert.equal(catchUp.entryCount, offlineMessages.length);
    assert.equal(client.lastSequence, offlineMessages.at(-1).sequence);
    report.steps.push({
      step: "reconnect-catch-up",
      ok: true,
      reconnectLatencyMs,
      ...catchUp,
    });

    await client.disconnect();
    report.ok = true;
  } catch (error) {
    primaryError = error;
    report.ok = false;
    report.error = String(error?.stack || error);
  } finally {
    if (args.cleanup && channelId) {
      try {
        await cleanupSyntheticChannel({
          hubUrl: args.hubUrl,
          token: args.token,
          channelId,
        });
        report.steps.push({ step: "cleanup-channel", ok: true, channelId });
      } catch (cleanupError) {
        report.ok = false;
        report.cleanupError = String(cleanupError?.stack || cleanupError);
        if (!primaryError) primaryError = cleanupError;
      }
    }
    report.finishedAt = new Date().toISOString();
    report.durationMs = performance.now() - started;
    await mkdir(args.resultsDir, { recursive: true });
    const reportPath = join(args.resultsDir, `reconnect_${Date.now().toString(36)}.json`);
    report.reportPath = reportPath;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (local) await local.worker.stop();
    console.log(JSON.stringify(report, null, 2));
  }
  if (primaryError) throw primaryError;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
