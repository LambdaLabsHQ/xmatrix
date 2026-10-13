import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { Page, Route } from "@playwright/test";
import { E2E_USER_SENDER, type HumanSocketFrame } from "./workspace-fixtures";

export type NativeHumanSocketTraffic = {
  counting: boolean;
  byType: Record<string, number>;
  lastStep: number;
  connections: number;
};

/** A real loopback WebSocket, independent of Playwright's injected message
 * delivery. Install before navigation. The navigation response admits only
 * this listener's exact origin in connect-src, preserving every other policy.
 * Only the Human socket's constructor URL changes; native delivery, buffering,
 * open/message/close events and the app's frame handlers remain in use. */
export async function routeNativeHumanSocket(
  page: Page,
  onFrame: (frame: HumanSocketFrame, reply: (message: unknown) => void, connection: number) => void,
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
    socket.on("message", raw => {
      const frame = JSON.parse(String(raw)) as HumanSocketFrame;
      if (frame.type === "human_connect") reply({
        type: "human_connected", requestId: frame.requestId,
        user: { id: E2E_USER_SENDER.userId, email: E2E_USER_SENDER.email, name: E2E_USER_SENDER.label },
      });
      onFrame(frame, reply, connection);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    listener.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  listener.unref();
  const address = listener.address() as AddressInfo;
  const endpoint = `ws://127.0.0.1:${address.port}/ws/humans`;
  const appDocument = (url: URL) => url.pathname === "/app" || url.pathname.startsWith("/app/");
  const navigation = async (route: Route) => {
    const request = route.request();
    if (request.resourceType() !== "document" || !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame()) return route.fallback();
    // A fulfilled navigation has no network address space. Admit this test
    // origin to its explicitly configured loopback listener in Chromium.
    await page.context().grantPermissions(["local-network-access"], { origin: new URL(request.url()).origin });
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
  let closing: Promise<void> | null = null;
  const onClose = () => { void close(); };
  const close = () => closing ??= new Promise<void>(resolve => {
    page.off("close", onClose);
    page.context().off("close", onClose);
    void page.unroute(appDocument, navigation).catch(() => {});
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
    await page.addInitScript(({ endpoint }) => {
      const NativeWebSocket = window.WebSocket;
      const traffic: NativeHumanSocketTraffic = { counting: false, byType: {}, lastStep: -1, connections: 0 };
      (window as unknown as { __nativeHumanSocketTraffic: NativeHumanSocketTraffic }).__nativeHumanSocketTraffic = traffic;
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
    }, { endpoint });
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
