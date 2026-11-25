import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

interface CloudflareSocketAddress {
  hostname: string;
  port: number;
}

interface CloudflareSocketOptions {
  secureTransport?: "on" | "off" | "starttls";
  allowHalfOpen?: boolean;
}

interface CloudflareTcpSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
  startTls(options?: Record<string, unknown>): CloudflareTcpSocket;
}

type CloudflareSocketConnect = (
  address: string | CloudflareSocketAddress,
  options?: CloudflareSocketOptions,
) => CloudflareTcpSocket;

type WriteCallback = (error?: Error | null) => void;

async function loadCloudflareSocketsConnect(): Promise<CloudflareSocketConnect> {
  const mod = (await import("cloudflare:sockets")) as unknown as {
    connect: CloudflareSocketConnect;
  };
  return mod.connect;
}

function isCloudflareWorkersRuntime(): boolean {
  return (
    typeof navigator === "object" &&
    navigator !== null &&
    navigator.userAgent === "Cloudflare-Workers"
  );
}

/**
 * Cloudflare Workers TCP socket adapter for node-postgres (`pg`).
 *
 * Unlike `pg-cloudflare@1.4.0`, this adapter:
 * 1. Handles Node's 2-argument `write(chunk, callback)` overload used by
 *    `pg`'s `Connection.end()` so `stream.end()` is actually invoked.
 * 2. Explicitly cancels/releases the readable reader, closes/aborts and
 *    releases the writable writer, and awaits `socket.close()` + `socket.closed`
 *    before emitting `"close"`, preventing unclosed outbound sockets from
 *    pinning Durable Objects alive after `client.end()`.
 *
 * @testonly Direct class export is for unit tests; production callers use `cloudflarePostgresStream`.
 */
export class CloudflarePostgresSocket extends EventEmitter {
  readonly ssl: boolean;
  writable = false;
  destroyed = false;

  private _upgrading = false;
  private _upgraded = false;
  private _closing: Promise<void> | null = null;
  private _closedEmitted = false;
  private _socket: CloudflareTcpSocket | null = null;
  private _writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor(
    ssl: boolean,
    private readonly _connectLoader: () => Promise<CloudflareSocketConnect> = loadCloudflareSocketsConnect,
  ) {
    super();
    this.ssl = ssl;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  async connect(port: number, host: string, connectListener?: () => void): Promise<this> {
    try {
      if (connectListener) this.once("connect", connectListener);
      const connect = await this._connectLoader();
      if (this._closing || this.destroyed) return this;

      const options: CloudflareSocketOptions = this.ssl ? { secureTransport: "starttls" } : {};
      const socket = connect(`${host}:${port}`, options);
      this._socket = socket;
      this._writer = socket.writable.getWriter();
      this._attachClosedHandler(socket);
      this._reader = socket.readable.getReader();

      void this._listen(this._reader, socket, this.ssl);

      await this._writer.ready;
      if (this._closing || this.destroyed || this._socket !== socket) return this;
      this.writable = true;
      this.emit("connect");
      return this;
    } catch (error) {
      if (!this._closing) {
        this.emit("error", error);
      }
      void this._teardown(true);
      return this;
    }
  }

  write(
    data: Uint8Array | Buffer | string,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    maybeCallback?: WriteCallback,
  ): boolean {
    let encoding: BufferEncoding = "utf8";
    let callback: WriteCallback | undefined;
    if (typeof encodingOrCallback === "function") {
      callback = encodingOrCallback;
    } else {
      if (encodingOrCallback) encoding = encodingOrCallback;
      callback = maybeCallback;
    }

    const chunk = typeof data === "string" ? Buffer.from(data, encoding) : data;
    if (chunk.length === 0) {
      callback?.();
      return true;
    }

    const writer = this._writer;
    if (!writer || this._closing) {
      callback?.(this._closing ? undefined : new Error("Cloudflare socket is not writable"));
      return false;
    }

    writer.write(chunk).then(
      () => callback?.(),
      (error: unknown) => callback?.(error instanceof Error ? error : new Error(String(error))),
    );
    return true;
  }

  end(
    dataOrCallback?: Uint8Array | Buffer | string | WriteCallback,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    maybeCallback?: WriteCallback,
  ): this {
    let data: Uint8Array | Buffer | string | undefined;
    let encoding: BufferEncoding = "utf8";
    let callback: WriteCallback | undefined;

    if (typeof dataOrCallback === "function") {
      callback = dataOrCallback;
    } else {
      data = dataOrCallback;
      if (typeof encodingOrCallback === "function") {
        callback = encodingOrCallback;
      } else {
        if (encodingOrCallback) encoding = encodingOrCallback;
        callback = maybeCallback;
      }
    }

    const chunk = data === undefined
      ? Buffer.alloc(0)
      : typeof data === "string"
        ? Buffer.from(data, encoding)
        : data;

    if (chunk.length > 0 && this._writer && !this._closing) {
      this.writable = false;
      this._writer.write(chunk).then(
        () => {
          void this._teardown(false).finally(() => callback?.());
        },
        (error: unknown) => {
          const writeError = error instanceof Error ? error : new Error(String(error));
          void this._teardown(true).finally(() => callback?.(writeError));
        },
      );
      return this;
    }

    this.writable = false;
    void this._teardown(false).finally(() => callback?.());
    return this;
  }

  destroy(_reason?: unknown): this {
    this.destroyed = true;
    this.writable = false;
    void this._teardown(true);
    return this;
  }

  startTls(options?: Record<string, unknown>): void {
    if (this._upgraded) {
      this.emit("error", "Cannot call `startTls()` more than once on a socket");
      return;
    }
    if (!this._socket || !this._writer || !this._reader || this._closing) {
      this.emit("error", new Error("Cannot start TLS on a closed socket"));
      return;
    }
    this._writer.releaseLock();
    this._reader.releaseLock();
    this._upgrading = true;
    const upgraded = this._socket.startTls(options);
    this._socket = upgraded;
    this._writer = upgraded.writable.getWriter();
    this._reader = upgraded.readable.getReader();
    this._attachClosedHandler(upgraded);
    void this._listen(this._reader, upgraded, false);
  }

  private async _listen(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    socket: CloudflareTcpSocket,
    once: boolean,
  ): Promise<void> {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) this.emit("data", Buffer.from(value));
        if (done) {
          if (!this._upgrading && !this._closing && this._socket === socket) {
            void this._teardown(false);
          }
          break;
        }
        if (once) break;
      }
    } catch (error) {
      if (!this._closing && !this._upgrading && this._socket === socket) {
        this.emit("error", error);
        void this._teardown(true);
      }
    }
  }

  private _attachClosedHandler(socket: CloudflareTcpSocket): void {
    socket.closed.then(
      () => {
        if (this._upgrading && this._socket !== socket) {
          this._upgrading = false;
          this._upgraded = true;
          return;
        }
        if (this._socket === socket) {
          void this._teardown(false);
        }
      },
      (error: unknown) => {
        if (this._upgrading && this._socket !== socket) {
          this._upgrading = false;
          return;
        }
        if (!this._closing && this._socket === socket) {
          this.emit("error", error);
          void this._teardown(true);
        }
      },
    );
  }

  private _teardown(force: boolean): Promise<void> {
    if (this._closing) return this._closing;
    this.writable = false;

    const socket = this._socket;
    const reader = this._reader;
    const writer = this._writer;
    this._socket = null;
    this._reader = null;
    this._writer = null;

    const stopReader = reader
      ? Promise.resolve()
          .then(() => reader.cancel())
          .catch(() => undefined)
          .finally(() => {
            try {
              reader.releaseLock();
            } catch {
              // Reader lock was already released.
            }
          })
      : Promise.resolve();

    const stopWriter = writer
      ? Promise.resolve()
          .then(() => (force ? writer.abort() : writer.close()))
          .catch(() => undefined)
          .finally(() => {
            try {
              writer.releaseLock();
            } catch {
              // Writer lock was already released.
            }
          })
      : Promise.resolve();

    this._closing = (async () => {
      if (force) {
        // Close the socket first so any stalled read/write rejects immediately,
        // then ensure reader/writer locks are released.
        const closeSocket = socket
          ? Promise.resolve().then(() => socket.close())
          : Promise.resolve();
        await Promise.allSettled([closeSocket, stopReader, stopWriter]);
      } else {
        await Promise.allSettled([stopReader, stopWriter]);
        if (socket) {
          await Promise.resolve()
            .then(() => socket.close())
            .catch(() => undefined);
        }
      }
      if (socket) {
        await Promise.resolve(socket.closed).catch(() => undefined);
      }
      if (!this._closedEmitted) {
        this._closedEmitted = true;
        this.emit("close");
      }
    })();

    return this._closing;
  }
}

/**
 * Returns a `pg` `stream` factory using `CloudflarePostgresSocket` when running
 * in Cloudflare Workers, or `undefined` in Node.js so `pg` keeps its native `net.Socket`.
 */
export function cloudflarePostgresStream(
  connectLoader?: () => Promise<CloudflareSocketConnect>,
): ((config?: { ssl?: unknown }) => Duplex) | undefined {
  if (!connectLoader && !isCloudflareWorkersRuntime()) return undefined;
  return (config?: { ssl?: unknown }) =>
    new CloudflarePostgresSocket(Boolean(config?.ssl), connectLoader) as unknown as Duplex;
}

interface EventedPgPool {
  on(event: "connect" | "remove", listener: (client: unknown) => void): unknown;
  end(): Promise<void>;
}

/**
 * Wraps `pg-pool`'s `end()` so it does not resolve until every connected client's
 * `client.end()` has emitted `"remove"`. `pg-pool` synchronously drops idle
 * clients from `_clients` and resolves `end()` before the underlying socket
 * teardown completes, which can leave outbound TCP sockets closing in the
 * background after a Durable Object handler returns.
 */
export function awaitPoolClientRemovals<TPool extends EventedPgPool>(
  pool: TPool,
  maxWaitMs = 5_000,
): TPool {
  const liveClients = new Set<unknown>();
  const waiters = new Set<() => void>();
  const flushWaiters = () => {
    if (liveClients.size > 0) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  pool.on("connect", (client) => {
    liveClients.add(client);
  });
  pool.on("remove", (client) => {
    liveClients.delete(client);
    flushWaiters();
  });

  const originalEnd = pool.end.bind(pool);
  pool.end = async (): Promise<void> => {
    await originalEnd();
    if (liveClients.size === 0) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      waiters.add(done);
      timer = setTimeout(done, maxWaitMs);
      if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
        timer.unref();
      }
      flushWaiters();
    });
  };
  return pool;
}
