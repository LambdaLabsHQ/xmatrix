import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { Page, Route } from "@playwright/test";
import { E2E_USER_SENDER, type HumanSocketFrame } from "./workspace-fixtures";
import type { HumanWorkerCommand, HumanWorkerEvent } from "../src/lib/connectivity/human-frame-packets";

export type NativeHumanSocketTraffic = {
  counting: boolean;
  byType: Record<string, number>;
  lastStep: number;
  connections: number;
  workerConnects: number;
  workerConnections: number;
  workerPackets: number;
};

export type NativeHumanSocketControl = {
  sendRaw(data: string): void;
  close(code?: number, reason?: string): void;
};

/** A real loopback WebSocket, independent of Playwright's injected message
 * delivery. Install before navigation. The navigation response admits only
 * this listener's exact origin in connect-src, preserving every other policy.
 * Only the Human socket's constructor URL changes; native delivery, buffering,
 * open/message/close events and the app's frame handlers remain in use. */
export async function routeNativeHumanSocket(
  page: Page,
  onFrame: (frame: HumanSocketFrame, reply: (message: unknown) => void, connection: number,
    control: NativeHumanSocketControl) => void,
) {
  const listener = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const server = new WebSocketServer({ server: listener, path: "/ws/humans", perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024 });
  let connections = 0;
  server.on("connection", socket => {
    const connection = ++connections;
    const reply = (message: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("The native Human fixture socket is not open");
      socket.send(JSON.stringify(message));
    };
    const control: NativeHumanSocketControl = {
      sendRaw: data => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    };
    socket.on("message", raw => {
      const frame = JSON.parse(String(raw)) as HumanSocketFrame;
      if (frame.type === "human_connect") reply({
        type: "human_connected", requestId: frame.requestId,
        user: { id: E2E_USER_SENDER.userId, email: E2E_USER_SENDER.email, name: E2E_USER_SENDER.label },
      });
      onFrame(frame, reply, connection, control);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    listener.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  listener.unref();
  const address = listener.address() as AddressInfo;
  const endpoint = `ws://127.0.0.1:${address.port}/ws/humans`;
  const workerEntryMarker = randomUUID();
  const serveWithSocketPolicy = async (route: Route) => {
    const response = await route.fetch();
    const headers = response.headers();
    const policy = headers["content-security-policy"];
    if (!policy || !/(^|;)\s*connect-src\s+[^;]+/u.test(policy)) {
      throw new Error("The native socket fixture requires the app's explicit connect-src policy");
    }
    headers["content-security-policy"] = policy.replace(/(^|;)(\s*connect-src\s+[^;]+)/u,
      (_directive, boundary: string, sources: string) => `${boundary}${sources} ${new URL(endpoint).origin}`);
    await route.fulfill({ response, headers });
  };
  const appDocument = (url: URL) => url.pathname === "/app" || url.pathname.startsWith("/app/");
  const navigation = async (route: Route) => {
    const request = route.request();
    if (request.resourceType() !== "document" || !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame()) return route.fallback();
    // A fulfilled navigation has no network address space. Admit this test
    // origin to its explicitly configured loopback listener in Chromium.
    await page.context().grantPermissions(["local-network-access"], { origin: new URL(request.url()).origin });
    await serveWithSocketPolicy(route);
  };
  const workerScript = (url: URL) => url.pathname.startsWith("/_next/static/") && url.pathname.endsWith(".js");
  const workerPolicy = async (route: Route) => {
    const request = route.request();
    // Worker scripts own their CSP. Admit the same exact loopback listener,
    // without altering asset bytes or any other resource's policy.
    if (new URL(request.url()).searchParams.get("native-human-worker") !== workerEntryMarker ||
        new URL(request.url()).origin !== new URL(page.url()).origin) return route.fallback();
    await serveWithSocketPolicy(route);
  };
  let closing: Promise<void> | null = null;
  const onClose = () => { void close(); };
  const close = () => closing ??= new Promise<void>(resolve => {
    page.off("close", onClose);
    page.context().off("close", onClose);
    void page.unroute(appDocument, navigation).catch(() => {});
    void page.unroute(workerScript, workerPolicy).catch(() => {});
    let pending = 2;
    const finish = () => {
      if (--pending > 0) return;
      clearTimeout(timeout);
      resolve();
    };
    // terminate() also destroys upgraded sockets, which closeAllConnections
    // deliberately excludes. Stop accepting connections before teardown waits.
    for (const socket of server.clients) socket.terminate();
    const timeout = setTimeout(() => {
      for (const socket of server.clients) socket.terminate();
      listener.closeAllConnections();
      resolve();
    }, 5_000);
    server.close(finish);
    listener.close(finish);
    listener.closeAllConnections();
  });
  page.once("close", onClose);
  page.context().once("close", onClose);
  try {
    await page.route(appDocument, navigation);
    await page.route(workerScript, workerPolicy);
    await page.addInitScript(({ endpoint, workerEntryMarker }) => {
      const NativeWebSocket = window.WebSocket;
      const traffic: NativeHumanSocketTraffic = { counting: false, byType: {}, lastStep: -1, connections: 0,
        workerConnects: 0, workerConnections: 0, workerPackets: 0 };
      (window as unknown as { __nativeHumanSocketTraffic: NativeHumanSocketTraffic }).__nativeHumanSocketTraffic = traffic;
      const NativeWorker = window.Worker;
      if (typeof NativeWorker === "function") window.Worker = class extends NativeWorker {
        private human = false;
        constructor(url: string | URL, options?: WorkerOptions) {
          // Chromium omits Fetch Metadata on routed Worker requests. Tag the
          // actual entry URL rather than guessing from other script requests;
          // its bytes and every other asset's CSP stay unchanged.
          const entry = new URL(String(url), location.href);
          if (entry.origin === location.origin && entry.pathname.startsWith("/_next/static/") && entry.pathname.endsWith(".js")) {
            entry.searchParams.set("native-human-worker", workerEntryMarker);
          }
          super(entry, options);
          this.addEventListener("message", (event: MessageEvent<HumanWorkerEvent>) => {
            if (!this.human) return;
            if (event.data.type === "open") {
              traffic.connections += 1;
              traffic.workerConnections += 1;
            }
            if (!traffic.counting || event.data.type !== "packet") return;
            traffic.workerPackets += 1;
            for (const frame of event.data.frames) {
              const value = frame.kind === "json" ? frame.value : undefined;
              const record = value && typeof value === "object" ? value as { type?: string; agent?: { activity?: string } } : undefined;
              const type = typeof record?.type === "string" ? record.type : "unknown";
              traffic.byType[type] = (traffic.byType[type] ?? 0) + 1;
              if (type === "enhanced_presence" || type === "presence") {
                const step = record?.agent?.activity?.match(/^Step (\d+)$/u);
                if (step) traffic.lastStep = Number(step[1]);
              }
            }
          });
        }
        postMessage(message: unknown, transfer: Transferable[]): void;
        postMessage(message: unknown, options?: StructuredSerializeOptions): void;
        postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]): void {
          const command = message as Partial<HumanWorkerCommand> | null;
          if (command?.type === "connect" && typeof command.url === "string") {
            const requested = new URL(command.url, location.href);
            if (requested.pathname === "/ws/humans") {
              this.human = true;
              traffic.workerConnects += 1;
              message = { ...command, url: endpoint + requested.search };
            }
          }
          if (Array.isArray(options)) super.postMessage(message, options);
          else super.postMessage(message, options);
        }
      };
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          const requested = new URL(String(url), location.href);
          const human = requested.pathname === "/ws/humans";
          super(human ? endpoint + requested.search : url, protocols);
          if (!human) return;
          this.addEventListener("open", () => { traffic.connections += 1; });
          this.addEventListener("message", event => {
            if (!traffic.counting || typeof event.data !== "string") return;
            // The fixture serializes normal Human frames with type first. Keep
            // accounting passive: no second JSON parse or CDP call per frame.
            const type = event.data.match(/^\{"type":"([^"]+)"/u)?.[1] ?? "unknown";
            traffic.byType[type] = (traffic.byType[type] ?? 0) + 1;
            if (type === "enhanced_presence" || type === "presence") {
              const step = event.data.match(/"activity":"Step (\d+)"/u);
              if (step) traffic.lastStep = Number(step[1]);
            }
          });
        }
      };
    }, { endpoint, workerEntryMarker });
  } catch (error) {
    await close();
    throw error;
  }
  return { connections: () => connections, close };
}

/** Set window.__nativeHumanSocketTraffic.counting before the measured window;
 * this one snapshot read happens after the window, never once per report. */
export async function readNativeHumanSocketTraffic(page: Page): Promise<NativeHumanSocketTraffic> {
  return page.evaluate(() => {
    const traffic = (window as unknown as { __nativeHumanSocketTraffic: NativeHumanSocketTraffic }).__nativeHumanSocketTraffic;
    return { ...traffic, byType: { ...traffic.byType } };
  });
}
