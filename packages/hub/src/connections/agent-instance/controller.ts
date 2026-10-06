import type { AgentInstanceClientMessage } from "@xmatrix/protocol/connections/agent-instance";
import {
  decodeSocketEndpointInput,
  SocketEndpoint,
  type SocketEndpointInput,
  type SocketEndpointPort,
} from "../../transport/socket-endpoint";

const AGENT_INSTANCE_MESSAGE_TYPES = new Set([
  "agent_instance_connect",
  "ping",
  "client_network_sample",
  "refresh_auth",
  "unregister",
  "join_channel",
  "replay_channel_history",
  "leave_channel",
  "channel_message",
  "channel_activity",
  "channel_message_ack",
  "get_channel_history",
  "presence_update",
  "agent_model_switch_result",
  "agent_effort_switch_result",
  "agent_lifecycle",
  "event_publish",
  "trace_history_result",
]);

export type AgentInstanceConnectionInput = SocketEndpointInput<AgentInstanceClientMessage>;

type AgentInstanceMessage<Type extends AgentInstanceClientMessage["type"]> = Extract<
  AgentInstanceClientMessage,
  { type: Type }
>;

/**
 * Agent-domain frames which can change Relay authority. The controller owns
 * this classification after bounded decoding; the Relay composition root only
 * supplies the current authority gate and the typed Authority/legacy adapters.
 */
export type AgentInstanceAuthorityMutation = Exclude<
  AgentInstanceClientMessage,
  | AgentInstanceMessage<"agent_instance_connect">
  | AgentInstanceMessage<"ping">
  | AgentInstanceMessage<"client_network_sample">
  | AgentInstanceMessage<"refresh_auth">
  | AgentInstanceMessage<"replay_channel_history">
  | AgentInstanceMessage<"get_channel_history">
  | AgentInstanceMessage<"trace_history_result">
>;

export interface AgentInstanceConnectionPort extends SocketEndpointPort {
  authorityMutation(
    ws: WebSocket,
    message: AgentInstanceAuthorityMutation,
    legacy: () => void | Promise<void>,
  ): void;
  connect(ws: WebSocket, message: AgentInstanceMessage<"agent_instance_connect">): void;
  ping(ws: WebSocket, requestId: string | undefined): void;
  networkSample(ws: WebSocket, message: AgentInstanceMessage<"client_network_sample">): void;
  refreshAuth(ws: WebSocket, message: AgentInstanceMessage<"refresh_auth">): void;
  unregister(ws: WebSocket, requestId: string | undefined): void;
  joinChannel(ws: WebSocket, message: AgentInstanceMessage<"join_channel">): void | Promise<void>;
  replayChannelHistory(ws: WebSocket, message: AgentInstanceMessage<"replay_channel_history">): void;
  leaveChannel(ws: WebSocket, message: AgentInstanceMessage<"leave_channel">): void;
  channelMessage(ws: WebSocket, message: AgentInstanceMessage<"channel_message">): void | Promise<void>;
  channelActivity(ws: WebSocket, message: AgentInstanceMessage<"channel_activity">): void | Promise<void>;
  acknowledgeChannelMessage(
    ws: WebSocket,
    message: AgentInstanceMessage<"channel_message_ack">,
  ): void | Promise<void>;
  getChannelHistory(ws: WebSocket, message: AgentInstanceMessage<"get_channel_history">): void;
  updatePresence(ws: WebSocket, message: AgentInstanceMessage<"presence_update">): void | Promise<void>;
  reportModelSwitch(ws: WebSocket, message: AgentInstanceMessage<"agent_model_switch_result">): void;
  reportEffortSwitch(ws: WebSocket, message: AgentInstanceMessage<"agent_effort_switch_result">): void;
  reportLifecycle(ws: WebSocket, message: AgentInstanceMessage<"agent_lifecycle">): void;
  publishEvent(ws: WebSocket, message: AgentInstanceMessage<"event_publish">): void;
  traceHistoryResult(ws: WebSocket, message: AgentInstanceMessage<"trace_history_result">): void;
}

export class AgentInstanceConnectionController {
  readonly socket: SocketEndpoint;

  constructor(private readonly port: AgentInstanceConnectionPort) {
    this.socket = new SocketEndpoint(port);
  }

  handleFrame(ws: WebSocket, frame: string | ArrayBuffer): void {
    const input = decodeAgentInstanceConnectionInput(frame, this.socket.isConnected(ws));
    const message = this.socket.consume(
      ws,
      input,
      input.ok && input.message.type !== "agent_instance_connect"
    );
    if (!message) return;
    switch (message.type) {
      case "agent_instance_connect": this.port.connect(ws, message); return;
      case "ping": this.port.ping(ws, message.requestId); return;
      case "client_network_sample": this.port.networkSample(ws, message); return;
      case "refresh_auth": this.port.refreshAuth(ws, message); return;
      case "unregister": this.port.authorityMutation(
        ws,
        message,
        () => this.port.unregister(ws, message.requestId),
      ); return;
      case "join_channel": this.port.authorityMutation(
        ws,
        message,
        () => this.port.joinChannel(ws, message),
      ); return;
      case "replay_channel_history": this.port.replayChannelHistory(ws, message); return;
      case "leave_channel": this.port.authorityMutation(
        ws,
        message,
        () => this.port.leaveChannel(ws, message),
      ); return;
      case "channel_message": this.port.authorityMutation(
        ws,
        message,
        () => this.port.channelMessage(ws, message),
      ); return;
      case "channel_activity": this.port.authorityMutation(
        ws,
        message,
        () => this.port.channelActivity(ws, message),
      ); return;
      case "channel_message_ack": this.port.authorityMutation(
        ws,
        message,
        () => this.port.acknowledgeChannelMessage(ws, message),
      ); return;
      case "get_channel_history": this.port.getChannelHistory(ws, message); return;
      case "presence_update": this.port.authorityMutation(
        ws,
        message,
        () => this.port.updatePresence(ws, message),
      ); return;
      case "agent_model_switch_result": this.port.authorityMutation(
        ws,
        message,
        () => this.port.reportModelSwitch(ws, message),
      ); return;
      case "agent_effort_switch_result": this.port.authorityMutation(
        ws,
        message,
        () => this.port.reportEffortSwitch(ws, message),
      ); return;
      case "agent_lifecycle": this.port.authorityMutation(
        ws,
        message,
        () => this.port.reportLifecycle(ws, message),
      ); return;
      case "event_publish": this.port.authorityMutation(
        ws,
        message,
        () => this.port.publishEvent(ws, message),
      ); return;
      case "trace_history_result": this.port.traceHistoryResult(ws, message); return;
    }
  }

}

/** Agent runtime endpoint state machine. It has no Human or daemon dependency. */
export function decodeAgentInstanceConnectionInput(
  frame: string | ArrayBuffer,
  connected: boolean
): AgentInstanceConnectionInput {
  return decodeSocketEndpointInput<AgentInstanceClientMessage>(frame, connected, {
    messageTypes: AGENT_INSTANCE_MESSAGE_TYPES,
    handshakeType: "agent_instance_connect",
    unsupportedMessage: "Unsupported Agent Instance connection message",
    unauthenticatedMessage: "Agent Instance must authenticate first",
    duplicateHandshakeMessage: "Agent Instance is already authenticated",
  });
}
