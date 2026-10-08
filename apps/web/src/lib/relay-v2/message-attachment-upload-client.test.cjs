const assert = require("node:assert/strict");
const cryptoModule = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const vm = require("node:vm");

const source = fs.readFileSync(`${__dirname}/message-attachment-upload-client.ts`, "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

let fetchImpl;
let id = 0;
let requests = [];

/**
 * Models the part of XMLHttpRequest this file depends on: `abort()` before
 * `send()` does nothing at all. A spy that just records the call would hide the
 * bug where a cancelled upload was aborted while still UNSENT and went out anyway.
 */
class FakeXMLHttpRequest {
  constructor() {
    this.readyState = 0;
    this.sent = false;
    this.aborted = false;
    this.upload = {};
    requests.push(this);
  }
  open(method, url) {
    this.readyState = 1;
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  send() {
    this.sent = true;
    this.readyState = 2;
  }
  /** Drive the upload progress the stall watchdog listens to. */
  progress(loaded, total) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  abort() {
    this.aborted = true;
    if (!this.sent) return; // UNSENT/OPENED abort is a no-op in the real thing
    this.onabort?.();
  }
}

/** The real transport, run against this file's fetch stub. */
const transport = (() => {
  const transportJs = ts.transpileModule(fs.readFileSync(`${__dirname}/../query/api-client.ts`, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const transportModule = { exports: {} };
  vm.runInNewContext(transportJs, {
    module: transportModule,
    exports: transportModule.exports,
    Error, DOMException, JSON, Math, Number, Date, Set, Object,
    fetch: (...args) => fetchImpl(...args),
    require,
  });
  return transportModule.exports;
})();

const moduleValue = { exports: {} };
vm.runInNewContext(js, {
  module: moduleValue,
  exports: moduleValue.exports,
  Blob,
  Error,
  JSON,
  Response,
  XMLHttpRequest: FakeXMLHttpRequest,
  // Request deadlines are timer-driven, so the sandbox has to expose timers,
  // cancellation and the DOMException used to mark a deadline abort. Keeping
  // this whitelist explicit is what makes a new global dependency visible.
  AbortController,
  DOMException,
  ReadableStream,
  clearTimeout,
  setTimeout,
  crypto: { randomUUID: () => `id-${++id}` },
  fetch: (...args) => fetchImpl(...args),
  require: (specifier) => {
    if (specifier === "@noble/hashes/sha2.js") {
      return {
        sha256: {
          create() {
            const hash = cryptoModule.createHash("sha256");
            return {
              update(bytes) {
                hash.update(bytes);
                return this;
              },
              digest() {
                return new Uint8Array(hash.digest());
              },
            };
          },
        },
      };
    }
    if (specifier === "@xmatrix/protocol/relay-v2/message-attachment") {
      return {
        RELAY_V2_BLOB_REF_PATH: "/api/relay-v2/private-r2/blob-refs",
        RELAY_V2_BLOB_UPLOAD_CHECKSUM_HEADER: "x-xmatrix-content-sha256",
        RELAY_V2_BLOB_UPLOAD_INTENT_PATH: "/api/relay-v2/private-r2/upload-intents",
        RELAY_V2_BLOB_UPLOAD_PREFIX: "/api/relay-v2/private-r2/uploads",
      };
    }
    if (specifier === "../query/api-client") return transport;
    return require(specifier);
  },
});

const {
  commitMessageAttachmentRefs,
  prepareMessageAttachmentUpload,
  sha256Blob,
} = moduleValue.exports;

function uploadInput(overrides) {
  return {
    file: new Blob([new Uint8Array([1, 2, 3])]),
    token: "human-token",
    visibilityScopeId: "space:space-1",
    mimeType: "image/png",
    ...overrides,
  };
}

const attachment = {
  attachmentId: "attachment-1",
  intentId: "intent-1",
  visibilityScopeId: "space:space-1",
  objectKey: `objects/${"a".repeat(64)}`,
  contentHash: "a".repeat(64),
  encodedBytes: 3,
  mimeType: "image/png",
  name: "image.png",
};

function admittedUploadResponse(_url, init) {
  const { intentId, visibilityScopeId } = JSON.parse(init.body);
  return Response.json({
    upload: {
      finalPath: `/api/relay-v2/private-r2/uploads/${encodeURIComponent(intentId)}` +
        `/scope/${encodeURIComponent(visibilityScopeId)}`,
    },
  });
}

async function assertCommitDeadline() {
  await assert.rejects(commitMessageAttachmentRefs({
    token: "human-token", messageId: "message-1", attachments: [attachment], controlDeadlineMs: 20,
  }), /timed out/u);
}

test("attachment hashing is incremental and produces lowercase SHA-256", async () => {
  assert.equal(
    await sha256Blob(new Blob([new Uint8Array([1, 2, 3])])),
    cryptoModule.createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex"),
  );
});

test("the request is handed over only once aborting it can do something", async () => {
  fetchImpl = admittedUploadResponse;
  requests = [];
  let stateWhenHandedOver = null;

  const pending = prepareMessageAttachmentUpload(
    uploadInput({
      onRequest: (request) => {
        stateWhenHandedOver = { readyState: request.readyState, hasAbortHandler: !!request.onabort };
      },
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(stateWhenHandedOver.readyState, 1, "onRequest must run after open(), not on a fresh request");
  assert.equal(stateWhenHandedOver.hasAbortHandler, true, "aborting before onabort exists would reject nothing");
  assert.equal(requests[0].sent, true, "a live upload still gets sent");
  assert.equal(
    requests[0].url,
    "/api/xmatrix/relay-v2/private-r2/uploads/id-1/scope/space%3Aspace-1",
    "the body must use the scoped authority path admitted by the Hub",
  );

  requests[0].onload = null;
  requests[0].abort();
  await assert.rejects(pending, /Upload cancelled/u);
});

test("an upload cancelled before it is sent never reaches the network", async () => {
  fetchImpl = admittedUploadResponse;
  requests = [];

  await assert.rejects(
    prepareMessageAttachmentUpload(uploadInput({ onRequest: () => false })),
    /Upload cancelled/u,
  );

  assert.equal(
    requests[0].sent,
    false,
    "abort() cannot stop an unsent request, so a cancelled upload must not be sent at all"
  );
});

test("an upload rejects a Hub path that does not match its intent and visibility scope", async () => {
  fetchImpl = async () => Response.json({
    upload: { finalPath: "/api/relay-v2/private-r2/uploads/id-1" },
  });
  requests = [];

  await assert.rejects(
    prepareMessageAttachmentUpload(uploadInput()),
    /invalid path/u,
  );
  assert.equal(requests.length, 0, "an unscoped or redirected body path must never be opened");
});

test("commit creates only a verified message-owned ref, visible as the message's Channel is", async () => {
  const calls = [];
  fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true });
  };
  // The file was uploaded to the Space; the closed Channel it is sent in sets who sees it.
  await commitMessageAttachmentRefs({
    token: "human-token",
    messageId: "message-1",
    visibilityScopeId: "channel:closed-1",
    attachments: [attachment],
  });
  assert.equal(calls[0].url, "/api/xmatrix/relay-v2/private-r2/blob-refs");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.refId, "attachment-1");
  assert.equal(body.ownerKind, "message_attachment");
  assert.equal(body.ownerId, "message-1");
  assert.equal(body.visibilityScopeId, "channel:closed-1");
  assert.equal(/dataUrl|url|accessToken|objectKey/u.test(calls[0].init.body), false);
});

// --- request deadlines -------------------------------------------------------
// Every hop used to be unbounded, so a stalled link left the composer on
// "uploading" with no timeout at all. Each hop now fails distinguishably.

test("a body transfer that never advances fails as stalled, not as cancelled", async () => {
  fetchImpl = admittedUploadResponse;
  requests = [];
  const pending = prepareMessageAttachmentUpload(uploadInput({ stallDeadlineMs: 20 }));
  await assert.rejects(pending, /stalled/u);
  assert.equal(requests[0].aborted, true, "a stalled transfer must be aborted, not left open");
});

test("progress rearms the stall watchdog so a slow upload is not cancelled", async () => {
  fetchImpl = admittedUploadResponse;
  requests = [];
  const pending = prepareMessageAttachmentUpload(uploadInput({ stallDeadlineMs: 60 }));
  // Beat faster than the deadline for longer than the deadline, then complete.
  for (let tick = 1; tick <= 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    requests[0].progress(tick, 5);
  }
  requests[0].status = 200;
  requests[0].responseText = "{}";
  requests[0].onload();
  const prepared = await pending;
  assert.equal(prepared.encodedBytes, 3);
  assert.equal(requests[0].aborted, false, "a transfer that keeps advancing must not be aborted");
});

test("an unanswered control-plane hop times out instead of hanging", async () => {
  fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });
  requests = [];
  await assert.rejects(
    prepareMessageAttachmentUpload(uploadInput({ controlDeadlineMs: 20 })),
    /timed out/u,
  );
  assert.equal(requests.length, 0, "the body must not be sent when the intent never came back");

  await assertCommitDeadline();
});

test("a response whose body never finishes still hits the deadline", async () => {
  // Headers arrive, so `fetch` resolves; the body then stalls. Clearing the
  // timer once `fetch` resolved would leave this hop unbounded.
  // A real Response over a stream that never closes, with the signal wired to
  // error the stream the way fetch ties a body to its abort signal. A plain
  // object with a hanging `json()` would not exercise streaming at all.
  fetchImpl = (_url, init) => {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
  requests = [];
  await assert.rejects(
    prepareMessageAttachmentUpload(uploadInput({ controlDeadlineMs: 20 })),
    /timed out/u,
    "the deadline must cover reading the response body, not just its headers",
  );
  assert.equal(requests.length, 0, "the body must not be sent when the intent never completed");

  await assertCommitDeadline();
});

test("progress events that do not advance loaded still count as stalled", async () => {
  fetchImpl = admittedUploadResponse;
  requests = [];
  const pending = prepareMessageAttachmentUpload(uploadInput({ stallDeadlineMs: 60 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Heartbeat faster than the deadline, but never move a byte.
  const beat = setInterval(() => requests[0]?.progress(7, 100), 15);
  try {
    await assert.rejects(
      pending,
      /stalled/u,
      "repeating the same loaded value must not keep the watchdog alive",
    );
  } finally {
    clearInterval(beat);
  }
});

test("a pre-send cancellation disarms the stall watchdog", async () => {
  fetchImpl = admittedUploadResponse;
  requests = [];
  // `onRequest` returning false cancels before the body is sent. The watchdog
  // is armed by then, and leaving it running would outlive the request.
  await assert.rejects(
    prepareMessageAttachmentUpload(uploadInput({
      stallDeadlineMs: 20,
      onRequest: () => false,
    })),
    /cancelled/u,
  );
  assert.equal(requests[0].sent, false, "a cancelled upload must never be sent");
  // If the watchdog were still armed it would fire here and abort a request
  // that no longer has an owner.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requests[0].aborted, false, "no watchdog may survive the cancellation");
});
