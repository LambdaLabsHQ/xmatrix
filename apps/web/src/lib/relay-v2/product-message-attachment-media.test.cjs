const assert = require("node:assert/strict");
const test = require("node:test");

// Drive the real shipped client against a fake product-media endpoint.
test("ProductMessageAttachmentMediaClient hydrates blob from product media headers", async () => {
  const { ProductMessageAttachmentMediaClient } = await import("./product-message-attachment-media.ts");
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const client = new ProductMessageAttachmentMediaClient(async (url, init) => {
    assert.match(String(url), /\/api\/xmatrix\/relay-v2\/message-attachments\/product-media$/u);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer test-token");
    const body = JSON.parse(init.body);
    assert.deepEqual(body, {
      channelId: "channel-1",
      messageId: "message-1",
      attachmentId: "attachment-1",
    });
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(bytes.byteLength),
        "x-xmatrix-attachment-id": "attachment-1",
        "x-xmatrix-attachment-name": encodeURIComponent("shot.png"),
        "x-xmatrix-attachment-version": "1",
        "x-xmatrix-attachment-size": String(bytes.byteLength),
        "x-xmatrix-content-hash": "a".repeat(64),
      },
    });
  });
  const result = await client.loadMessageAttachment("test-token", {
    channelId: "channel-1",
    messageId: "message-1",
    attachmentId: "attachment-1",
  });
  assert.equal(result.kind, "message_attachment_ready");
  assert.equal(result.source, "network");
  assert.equal(result.retained, false);
  assert.equal(result.attachment.id, "attachment-1");
  assert.equal(result.attachment.name, "shot.png");
  assert.equal(result.attachment.mimeType, "image/png");
  assert.equal(result.attachment.size, bytes.byteLength);
  assert.equal(result.attachment.version, 1);
  assert.equal(result.body.size, bytes.byteLength);
  assert.equal(result.body.type, "image/png");
});

test("ProductMessageAttachmentMediaClient tolerates missing metadata headers when body is present", async () => {
  const { ProductMessageAttachmentMediaClient } = await import("./product-message-attachment-media.ts");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const client = new ProductMessageAttachmentMediaClient(async () =>
    new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    }),
  );
  const result = await client.loadMessageAttachment("tok", {
    channelId: "c",
    messageId: "m",
    attachmentId: "a1",
  });
  assert.equal(result.attachment.id, "a1");
  assert.equal(result.attachment.size, 4);
  assert.equal(result.attachment.mimeType, "image/png");
  assert.equal(result.body.size, 4);
});

test("ProductMessageAttachmentMediaClient fails closed on non-OK product media responses", async () => {
  const { ProductMessageAttachmentMediaClient } = await import("./product-message-attachment-media.ts");
  const client = new ProductMessageAttachmentMediaClient(async () =>
    new Response(JSON.stringify({ error: "message attachment is not available", code: "not_authorized" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  );
  await assert.rejects(
    () => client.loadMessageAttachment("tok", {
      channelId: "c",
      messageId: "m",
      attachmentId: "a",
    }),
    (error) => error.message.includes("not available") && error.status === 403,
  );
});

test("ProductMessageAttachmentMediaClient binds native fetch (no Illegal invocation)", async () => {
  const { ProductMessageAttachmentMediaClient } = await import("./product-message-attachment-media.ts");
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array([9, 8, 7, 6]);
  let callCount = 0;
  // Mimic Chromium: native fetch rejects when called without the Window/global receiver.
  globalThis.fetch = function mockFetch(url, init) {
    callCount += 1;
    // eslint-disable-next-line no-invalid-this -- intentional receiver check for the regression
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    assert.match(String(url), /product-media$/u);
    assert.equal(init?.method, "POST");
    return Promise.resolve(new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "x-xmatrix-attachment-id": "a",
        "x-xmatrix-attachment-size": String(bytes.byteLength),
        "x-xmatrix-attachment-version": "1",
      },
    }));
  };
  try {
    // Default client must not store unbound globalThis.fetch.
    const client = new ProductMessageAttachmentMediaClient();
    const result = await client.loadMessageAttachment("tok", {
      channelId: "c",
      messageId: "m",
      attachmentId: "a",
    });
    assert.equal(result.body.size, bytes.byteLength);
    // Explicit unbound native fetch must also be rebound.
    const unbound = globalThis.fetch;
    const client2 = new ProductMessageAttachmentMediaClient(unbound);
    const result2 = await client2.loadMessageAttachment("tok", {
      channelId: "c",
      messageId: "m",
      attachmentId: "a",
    });
    assert.equal(result2.body.size, bytes.byteLength);
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ProductMessageAttachmentMediaClient retains bodies and reuses them on later loads", async () => {
  const { ProductMessageAttachmentMediaClient } = await import("./product-message-attachment-media.ts");
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  let fetches = 0;
  const stored = new Map();
  const cache = {
    async match(request) {
      return stored.get(request)?.clone();
    },
    async put(request, response) {
      stored.set(request, response.clone());
    },
  };
  const client = new ProductMessageAttachmentMediaClient(async () => {
    fetches += 1;
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "x-xmatrix-attachment-id": "att-1",
        "x-xmatrix-attachment-name": encodeURIComponent("notes.pdf"),
        "x-xmatrix-attachment-version": "1",
        "x-xmatrix-attachment-size": String(bytes.byteLength),
      },
    });
  }, cache);
  const ref = { channelId: "c", messageId: "m", attachmentId: "att-1" };
  const first = await client.loadMessageAttachment("tok", ref);
  assert.equal(first.source, "network");
  assert.equal(first.retained, true);
  assert.equal(first.attachment.mimeType, "application/pdf");
  const second = await client.loadMessageAttachment("tok", ref);
  assert.equal(second.source, "cache");
  assert.equal(second.retained, true);
  assert.equal(second.body.size, bytes.byteLength);
  assert.equal(fetches, 1);
});
