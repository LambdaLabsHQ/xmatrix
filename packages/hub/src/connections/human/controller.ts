import type { HumanClientMessage } from "@xmatrix/protocol/connections/human";
import {
  decodeSocketEndpointInput,
  SocketEndpoint,
  type SocketEndpointInput,
  type SocketEndpointPort,
} from "../../transport/socket-endpoint";

const HUMAN_MESSAGE_TYPES = new Set([
  "human_connect",
  "user_focus_channel",
  "ping",
]);

export type HumanConnectionInput = SocketEndpointInput<HumanClientMessage>;

export interface HumanConnectionPort extends SocketEndpointPort {
  connect(ws: WebSocket, message: Extract<HumanClientMessage, { type: "human_connect" }>): void;
  focusChannel(
    ws: WebSocket,
    message: Extract<HumanClientMessage, { type: "user_focus_channel" }>
  ): void;
  ping(ws: WebSocket, requestId: string | undefined): void;
}

export class HumanConnectionController {
  readonly socket: SocketEndpoint;

  constructor(private readonly port: HumanConnectionPort) {
    this.socket = new SocketEndpoint(port);
  }

  handleFrame(ws: WebSocket, frame: string | ArrayBuffer): void {
    const input = decodeHumanConnectionInput(frame, this.socket.isConnected(ws));
    const message = this.socket.consume(ws, input, input.ok && input.message.type !== "human_connect");
    if (!message) return;
    switch (message.type) {
      case "human_connect":
        this.port.connect(ws, message);
        return;
      case "user_focus_channel":
        this.port.focusChannel(ws, message);
        return;
      case "ping":
        this.port.ping(ws, message.requestId);
        return;
    }
  }
}

/** Human endpoint state machine. It has no Agent Instance or daemon dependency. */
export function decodeHumanConnectionInput(
  frame: string | ArrayBuffer,
  connected: boolean
): HumanConnectionInput {
  return decodeSocketEndpointInput<HumanClientMessage>(frame, connected, {
    messageTypes: HUMAN_MESSAGE_TYPES,
    handshakeType: "human_connect",
    unsupportedMessage: "Unsupported Human connection message",
    unauthenticatedMessage: "Human connection must authenticate first",
    duplicateHandshakeMessage: "Human connection is already authenticated",
  });
}
