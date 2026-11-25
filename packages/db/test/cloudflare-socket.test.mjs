import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  awaitPoolClientRemovals,
  CloudflarePostgresSocket,
  cloudflarePostgresStream,
} from "../dist/index.js";

function createFakeCloudflareSocket(options = {}) {
  let readController;
  let closeResolved = false;
  let resolveClosed;
  let rejectStalledWrite;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const events = [];
  const written = [];

  const readable = new ReadableStream({
    start(controller) {
      readController = controller;
    },
    cancel() {
      events.push("reader.cancel");
    },
  });

  const writable = new WritableStream({
    async write(chunk) {
      events.push("writer.write");
      if (options.stallWrite) {
        await new Promise((_, reject) => {
          rejectStalledWrite = reject;
        });
      }
      written.push(Buffer.from(chunk));
    },
    close() {
      events.push("writer.close");
    },
    abort() {
      events.push("writer.abort");
    },
  });

  const socket = {
    readable,
    writable,
    closed,
    async close() {
      events.push("socket.close");
      rejectStalledWrite?.(new Error("socket closed"));
      if (!closeResolved) {
        closeResolved = true;
        if (options.delayCloseMs) {
          await new Promise((r) => setTimeout(r, options.delayCloseMs));
        }
        resolveClosed();
      }
    },
    startTls() {
      events.push("socket.startTls");
      if (!closeResolved) {
        closeResolved = true;
        resolveClosed();
      }
      return options.tlsSocket ?? createFakeCloudflareSocket().socket;
    },
  };

  return {
    socket,
    events,
    written,
    pushData(bytes) {
      readController.enqueue(bytes);
    },
    remoteClose() {
      try {
        readController.close();
      } catch {
        // Already closed or cancelled.
      }
      if (!closeResolved) {
        closeResolved = true;
        resolveClosed();
      }
    },
  };
}

async function openTestSocket(options = {}) {
  const fake = createFakeCloudflareSocket(options);
  const socket = new CloudflarePostgresSocket(Boolean(options.ssl), async () => () => fake.socket);
  const errors = [];
  socket.on("error", (err) => errors.push(err));
  let closeCount = 0;
  let stateAtClose;
  const closed = new Promise((resolve) => {
    socket.on("close", () => {
      closeCount += 1;
      stateAtClose = {
        readableLocked: fake.socket.readable.locked,
        writableLocked: fake.socket.writable.locked,
        writable: socket.writable,
        events: [...fake.events],
      };
      resolve();
    });
  });

  const connected = new Promise((resolve) => socket.once("connect", resolve));
  void socket.connect(5432, "hyperdrive.local");
  await connected;

  return {
    fake,
    socket,
    errors,
    closed,
    getCloseCount: () => closeCount,
    getStateAtClose: () => stateAtClose,
  };
}

test("CloudflarePostgresSocket handles pg Connection.end two-argument write and releases stream locks before close", async () => {
  const { fake, socket, closed, getCloseCount, getStateAtClose } = await openTestSocket({ delayCloseMs: 10 });

  const received = [];
  socket.on("data", (buf) => received.push(buf));
  assert.equal(socket.writable, true);
  assert.equal(fake.socket.readable.locked, true);
  assert.equal(fake.socket.writable.locked, true);

  fake.pushData(new Uint8Array([0x5a, 0x00, 0x00, 0x00, 0x05, 0x49]));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(received.length, 1);

  // Exact call pattern used by pg's Connection.end(): 2-arg write(endBuffer, cb) -> stream.end().
  const terminateMsg = Buffer.from([0x58, 0x00, 0x00, 0x00, 0x04]);
  socket.write(terminateMsg, () => {
    socket.end();
  });

  await closed;
  const atClose = getStateAtClose();
  assert.equal(getCloseCount(), 1);
  assert.deepEqual(fake.written, [terminateMsg]);
  assert.equal(atClose.readableLocked, false);
  assert.equal(atClose.writableLocked, false);
  assert.equal(atClose.writable, false);
  assert.ok(atClose.events.includes("reader.cancel"));
  assert.ok(atClose.events.includes("writer.close"));
  assert.ok(atClose.events.includes("socket.close"));
});

test("CloudflarePostgresSocket destroy aborts stalled writes, unlocks streams, and emits close once", async () => {
  const { fake, socket, errors, closed, getCloseCount } = await openTestSocket({ stallWrite: true });

  socket.write(Buffer.from("SELECT 1"));
  socket.destroy(new Error("timeout expired"));
  socket.end();

  await closed;
  assert.equal(getCloseCount(), 1);
  assert.equal(errors.length, 0);
  assert.equal(socket.destroyed, true);
  assert.equal(fake.socket.readable.locked, false);
  assert.equal(fake.socket.writable.locked, false);
  assert.ok(fake.events.includes("reader.cancel"));
  assert.ok(fake.events.includes("socket.close"));
});

test("CloudflarePostgresSocket remote EOF releases reader and writer locks before emitting close", async () => {
  const { fake, socket, closed, getCloseCount } = await openTestSocket();

  fake.remoteClose();
  await closed;

  let endCbCalled = false;
  await new Promise((resolve) => {
    socket.end(() => {
      endCbCalled = true;
      resolve();
    });
  });

  assert.equal(endCbCalled, true);
  assert.equal(getCloseCount(), 1);
  assert.equal(fake.socket.readable.locked, false);
  assert.equal(fake.socket.writable.locked, false);
});

test("CloudflarePostgresSocket startTls upgrades cleanly and closes upgraded streams", async () => {
  const tlsFake = createFakeCloudflareSocket();
  const rawFake = createFakeCloudflareSocket({ tlsSocket: tlsFake.socket });
  const factory = cloudflarePostgresStream(async () => () => rawFake.socket);
  assert.ok(factory);

  const socket = factory({ ssl: true });
  const connected = new Promise((resolve) => socket.once("connect", resolve));
  const firstChunk = new Promise((resolve) => socket.once("data", resolve));
  void socket.connect(5432, "db.example.com");
  await connected;

  rawFake.pushData(new Uint8Array([0x53])); // 'S' SSL supported
  assert.equal((await firstChunk).toString("utf8"), "S");

  let closedCount = 0;
  socket.on("close", () => {
    closedCount += 1;
  });

  socket.startTls({});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(closedCount, 0);
  assert.equal(rawFake.socket.readable.locked, false);
  assert.equal(rawFake.socket.writable.locked, false);
  assert.equal(tlsFake.socket.readable.locked, true);
  assert.equal(tlsFake.socket.writable.locked, true);

  const tlsClosed = new Promise((resolve) => socket.once("close", resolve));
  socket.end();
  await tlsClosed;

  assert.equal(closedCount, 1);
  assert.equal(tlsFake.socket.readable.locked, false);
  assert.equal(tlsFake.socket.writable.locked, false);
  assert.ok(tlsFake.events.includes("socket.close"));
});

test("awaitPoolClientRemovals waits for connected clients to finish client.end before resolving pool.end", async () => {
  const pool = new EventEmitter();
  let removed = false;
  const client = { id: 1 };
  pool.end = async () => {
    // Mirrors pg-pool: pool.end() resolves synchronously before client.end() finishes.
    setTimeout(() => {
      removed = true;
      pool.emit("remove", client);
    }, 15);
  };

  awaitPoolClientRemovals(pool, 1_000);
  pool.emit("connect", client);

  await pool.end();
  assert.equal(removed, true);
});
