declare module "cloudflare:sockets" {
  export function connect(
    address: string | { hostname: string; port: number },
    options?: { secureTransport?: "on" | "off" | "starttls"; allowHalfOpen?: boolean },
  ): {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
    startTls(options?: Record<string, unknown>): {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      readonly closed: Promise<void>;
      close(): Promise<void>;
      startTls(options?: Record<string, unknown>): unknown;
    };
  };
}
