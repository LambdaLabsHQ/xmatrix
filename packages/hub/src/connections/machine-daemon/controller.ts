import type { MachineDaemonClientMessage } from "@xmatrix/protocol/connections/machine-daemon";
import {
  decodeSocketEndpointInput,
  SocketEndpoint,
  type SocketEndpointInput,
  type SocketEndpointPort,
} from "../../transport/socket-endpoint";

const MACHINE_DAEMON_MESSAGE_TYPES = new Set([
  "machine_daemon_connect",
  "ping",
  "refresh_auth",
  "unregister",
  "machine_spawn_auth_required",
  "machine_spawn_result",
  "machine_run_exited",
  "machine_run_snapshot",
  "machine_stop_result",
  "machine_request_resolve_result",
  "machine_request_notice",
  "machine_worktree_cleanup_result",
  "machine_recover_reply_result",
  "machine_quota_probe_result",
  "machine_harness_action_result",
  "machine_worktree_action_result",
  "machine_command_lease_renew",
  "machine_command_admitted",
  "machine_activation_begin",
  "machine_activation_prepare",
  "machine_activation_advance",
]);

export type MachineDaemonConnectionInput = SocketEndpointInput<MachineDaemonClientMessage>;

type MachineDaemonMessage<Type extends MachineDaemonClientMessage["type"]> = Extract<
  MachineDaemonClientMessage,
  { type: Type }
>;

export interface MachineDaemonConnectionPort extends SocketEndpointPort {
  connect(ws: WebSocket, message: MachineDaemonMessage<"machine_daemon_connect">): void;
  ping(ws: WebSocket, requestId: string | undefined): void;
  refreshAuth(ws: WebSocket, message: MachineDaemonMessage<"refresh_auth">): void;
  unregister(ws: WebSocket, requestId: string | undefined): void;
  reportSpawnAuthRequired(ws: WebSocket, message: MachineDaemonMessage<"machine_spawn_auth_required">): void;
  reportSpawnResult(ws: WebSocket, message: MachineDaemonMessage<"machine_spawn_result">): void;
  reportRunExited(ws: WebSocket, message: MachineDaemonMessage<"machine_run_exited">): void;
  reportRunSnapshot(ws: WebSocket, message: MachineDaemonMessage<"machine_run_snapshot">): void;
  reportStopResult(ws: WebSocket, message: MachineDaemonMessage<"machine_stop_result">): void;
  reportRequestResolution(ws: WebSocket, message: MachineDaemonMessage<"machine_request_resolve_result">): void;
  reportRequestNotice(ws: WebSocket, message: MachineDaemonMessage<"machine_request_notice">): void;
  reportReplyRecovery(ws: WebSocket, message: MachineDaemonMessage<"machine_recover_reply_result">): void;
  reportQuotaProbe(ws: WebSocket, message: MachineDaemonMessage<"machine_quota_probe_result">): void;
  reportHarnessAction(ws: WebSocket, message: MachineDaemonMessage<"machine_harness_action_result">): void;
  reportWorktreeAction(ws: WebSocket, message: MachineDaemonMessage<"machine_worktree_action_result">): void;
  reportWorktreeCleanup(ws: WebSocket, message: MachineDaemonMessage<"machine_worktree_cleanup_result">): void;
  renewCommandLease(ws: WebSocket, message: MachineDaemonMessage<"machine_command_lease_renew">): void;
  admitCommand(ws: WebSocket, message: MachineDaemonMessage<"machine_command_admitted">): void;
  beginActivation(ws: WebSocket, message: MachineDaemonMessage<"machine_activation_begin">): void;
  prepareActivation(ws: WebSocket, message: MachineDaemonMessage<"machine_activation_prepare">): void;
  advanceActivation(ws: WebSocket, message: MachineDaemonMessage<"machine_activation_advance">): void;
}

export class MachineDaemonConnectionController {
  readonly socket: SocketEndpoint;

  constructor(private readonly port: MachineDaemonConnectionPort) {
    this.socket = new SocketEndpoint(port);
  }

  handleFrame(ws: WebSocket, frame: string | ArrayBuffer): void {
    const input = decodeMachineDaemonConnectionInput(frame, this.socket.isConnected(ws));
    const message = this.socket.consume(
      ws,
      input,
      input.ok && input.message.type !== "machine_daemon_connect"
    );
    if (!message) return;
    switch (message.type) {
      case "machine_daemon_connect": this.port.connect(ws, message); return;
      case "ping": this.port.ping(ws, message.requestId); return;
      case "refresh_auth": this.port.refreshAuth(ws, message); return;
      case "unregister": this.port.unregister(ws, message.requestId); return;
      case "machine_spawn_auth_required": this.port.reportSpawnAuthRequired(ws, message); return;
      case "machine_spawn_result": this.port.reportSpawnResult(ws, message); return;
      case "machine_run_exited": this.port.reportRunExited(ws, message); return;
      case "machine_run_snapshot": this.port.reportRunSnapshot(ws, message); return;
      case "machine_stop_result": this.port.reportStopResult(ws, message); return;
      case "machine_request_resolve_result": this.port.reportRequestResolution(ws, message); return;
      case "machine_request_notice": this.port.reportRequestNotice(ws, message); return;
      case "machine_recover_reply_result": this.port.reportReplyRecovery(ws, message); return;
      case "machine_quota_probe_result": this.port.reportQuotaProbe(ws, message); return;
      case "machine_harness_action_result": this.port.reportHarnessAction(ws, message); return;
      case "machine_worktree_action_result": this.port.reportWorktreeAction(ws, message); return;
      case "machine_worktree_cleanup_result": this.port.reportWorktreeCleanup(ws, message); return;
      case "machine_command_lease_renew": this.port.renewCommandLease(ws, message); return;
      case "machine_command_admitted": this.port.admitCommand(ws, message); return;
      case "machine_activation_begin": this.port.beginActivation(ws, message); return;
      case "machine_activation_prepare": this.port.prepareActivation(ws, message); return;
      case "machine_activation_advance": this.port.advanceActivation(ws, message); return;
    }
  }

}

/** Machine control endpoint state machine. It has no Human or Agent dependency. */
export function decodeMachineDaemonConnectionInput(
  frame: string | ArrayBuffer,
  connected: boolean
): MachineDaemonConnectionInput {
  return decodeSocketEndpointInput<MachineDaemonClientMessage>(frame, connected, {
    messageTypes: MACHINE_DAEMON_MESSAGE_TYPES,
    handshakeType: "machine_daemon_connect",
    unsupportedMessage: "Unsupported Machine Daemon connection message",
    unauthenticatedMessage: "Machine Daemon must authenticate first",
    duplicateHandshakeMessage: "Machine Daemon is already authenticated",
  });
}
