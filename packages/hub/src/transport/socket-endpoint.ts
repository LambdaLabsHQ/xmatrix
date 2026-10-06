import { decodeBoundedJsonObject } from "./bounded-json";

export type SocketEndpointInput<Message> =
  | { ok: true; message: Message }
  | { ok: false; error: string; close: boolean };

/**
 * Byte-transport callbacks with no Human, Agent, Machine, identity, or
 * protocol semantics. Domain controllers compose this adapter and continue to
 * own their message sets, dispatch, and authentication state transitions.
 */
export interface SocketEndpointPort {
  accept(ws: WebSocket): void;
  owns(ws: WebSocket): boolean;
  isConnected(ws: WebSocket): boolean;
  touch(ws: WebSocket): void;
  sendError(ws: WebSocket, requestId: string | undefined, message: string): void;
  close(ws: WebSocket, code: number, reason: string): void;
  disconnected(ws: WebSocket, code?: number, reason?: string, wasClean?: boolean): void;
}

export class SocketEndpoint {
  constructor(private readonly port: SocketEndpointPort) {}

  accept(ws: WebSocket): void {
    this.port.accept(ws);
  }

  owns(ws: WebSocket): boolean {
    return this.port.owns(ws);
  }

  isConnected(ws: WebSocket): boolean {
    return this.port.isConnected(ws);
  }

  consume<Message>(
    ws: WebSocket,
    input: SocketEndpointInput<Message>,
    recordsActivity: boolean
  ): Message | undefined {
    if (!input.ok) {
      this.port.sendError(ws, undefined, input.error);
      if (input.close) this.port.close(ws, 1008, input.error);
      return undefined;
    }
    if (recordsActivity) this.port.touch(ws);
    return input.message;
  }

  handleClose(ws: WebSocket, code?: number, reason?: string, wasClean?: boolean): void {
    this.port.disconnected(ws, code, reason, wasClean);
  }
}

export interface SocketHandshakePolicy {
  readonly messageTypes: ReadonlySet<string>;
  readonly handshakeType: string;
  readonly unsupportedMessage: string;
  readonly unauthenticatedMessage: string;
  readonly duplicateHandshakeMessage: string;
}

/** Semantics-free bounded decoding plus the universal one-handshake phase. */
export function decodeSocketEndpointInput<Message>(
  frame: string | ArrayBuffer,
  connected: boolean,
  policy: SocketHandshakePolicy
): SocketEndpointInput<Message> {
  const decoded = decodeBoundedJsonObject(frame);
  if (!decoded.ok) return { ...decoded, close: false };
  const type = decoded.value.type;
  if (typeof type !== "string" || !policy.messageTypes.has(type)) {
    return { ok: false, error: policy.unsupportedMessage, close: true };
  }
  if (!connected && type !== policy.handshakeType) {
    return { ok: false, error: policy.unauthenticatedMessage, close: true };
  }
  if (connected && type === policy.handshakeType) {
    return { ok: false, error: policy.duplicateHandshakeMessage, close: false };
  }
  return { ok: true, message: decoded.value as unknown as Message };
}
