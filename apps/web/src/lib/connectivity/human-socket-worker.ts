import { createHumanFramePackets, type HumanWorkerCommand, type HumanWorkerEvent } from "./human-frame-packets";
import type { SocketTransport } from "./reconnecting-socket";

export interface HumanSocketWorkerScope {
  postMessage(message: HumanWorkerEvent): void;
  addEventListener(type: "message", listener: (event: MessageEvent<HumanWorkerCommand>) => void): void;
}

/** One physical socket, with no authentication, retry or application-state policy. */
export function installHumanSocketWorker(
  scope: HumanSocketWorkerScope,
  open: (url: string) => SocketTransport = (url) => new WebSocket(url),
): void {
  let socket: SocketTransport | undefined;
  let finished = false;
  const packets = createHumanFramePackets({
    deliver: (frames) => scope.postMessage({ type: "packet", frames }),
  });
  const fail = () => {
    if (finished) return;
    finished = true;
    packets.dispose();
    scope.postMessage({ type: "failed" });
  };

  scope.addEventListener("message", ({ data }) => {
    if (finished) return;
    try {
      switch (data.type) {
        case "connect": {
          if (socket) return;
          socket = open(data.url);
          socket.addEventListener("open", () => {
            if (!finished) scope.postMessage({ type: "open" });
          });
          socket.addEventListener("message", (event) => {
            if (!finished) packets.push(event.data);
          });
          socket.addEventListener("close", (event) => {
            if (finished) return;
            packets.flush();
            finished = true;
            packets.dispose();
            scope.postMessage({ type: "close", code: event.code, reason: event.reason, wasClean: event.wasClean });
          });
          socket.addEventListener("error", () => {
            if (finished) return;
            packets.flush();
            scope.postMessage({ type: "error" });
          });
          return;
        }
        case "send":
          if (socket?.readyState === 1) socket.send(data.data);
          return;
        case "close":
          packets.dispose();
          socket?.close(data.code, data.reason);
          return;
      }
    } catch {
      fail();
    }
  });
  // The main thread sends `connect` only after this handshake. A script/CSP
  // startup failure therefore cannot leave a physical socket behind on fallback.
  scope.postMessage({ type: "ready" });
}
