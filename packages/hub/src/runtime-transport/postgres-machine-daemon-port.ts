import { plainRecord } from "@xmatrix/protocol";
import { machineHostnameObservation } from "../machine-hostname-observation";
import type {
  MachineDaemonClientMessage,
  MachineDaemonCommandLease,
  MachineDaemonConnectMessage,
  MachineDaemonRequestResolveCommand,
  MachineDaemonServerMessage,
  MachineDaemonSpawnCommand,
  MachineDaemonRecoverReplyCommand,
  MachineDaemonQuotaProbeCommand,
  MachineDaemonHarnessActionCommand,
  MachineDaemonStopCommand,
  MachineDaemonWorktreeCleanupCommand,
} from "@xmatrix/protocol/connections/machine-daemon";
import type { SerializedMachineDaemon } from "@xmatrix/protocol";
import { isAgentStatus, MACHINE_HARNESS_ACTION_CAPABILITY, parseHarnessActionRequest, parseRoutingQuotaProbeRequest,
  withMachineSpawnHarness, sha256Hex } from "@xmatrix/protocol";

import {
  machineDaemonCommandPrincipal,
  verifyMachineDaemonCredential,
  type MachineDaemonPrincipal,
} from "../connections/machine-daemon/auth";
import type { Env } from "../types";
import { dispatchProductChannelAbout } from "../product-agent-mention-authority-adapter";
import {
  MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES,
  machineDaemonRouteKey,
  type MachineDaemonAuthorityPrincipal,
  type MachineDaemonSocketBackend,
  type MachineDaemonRouteIdentity,
  type MachineDaemonRuntimeSession,
} from "./machine-daemon-port";
import {
  recordValue,
  runtimeCommandId,
} from "./runtime-messages";
import { recordAgentLaunchStage } from "../postgres-observability";
import { isRecoverableLaunchFailure } from "../live-run-admission";
import { boundedOccurrenceAt } from "../bounded-occurrence-time";
import { wakeAgentLaunchCoordinator } from "../agent-launch-coordinator-wake";
import { wakeMachineChannels } from "../registration-authority-wake";
import { machineDaemonCommand } from "../machines";
import { machineRunLifecycleReport } from "../machine-run-lifecycle-report";
import { updateAgentLaunch } from "../runtime";

type ExecutableMessage = Exclude<
  MachineDaemonClientMessage,
  MachineDaemonConnectMessage | { type: "ping" } | { type: "refresh_auth" }
>;

const COMPLETION_EVENTS = new Set([
  "machine_spawn_result",
  "machine_stop_result",
  "machine_request_resolve_result",
  "machine_worktree_cleanup_result",
  "machine_recover_reply_result",
  "machine_quota_probe_result",
  "machine_harness_action_result",
]);
const PRIVATE_AUDIT_FIELDS = new Set([
  "token",
  "userCode",
  "verificationUriComplete",
  "secretGrantId",
]);

export interface PostgresMachineDaemonPortDependencies {
  authenticate(token: string): Promise<MachineDaemonPrincipal>;
  /** Applies one daemon control command to the owner's Machine. */
  daemonCommand(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Records one Run lifecycle event on its Space's shard. */
  runLifecycleReport(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Moves an Agent Launch along as the daemon admits or spawns it. */
  launchUpdate(input: Parameters<typeof updateAgentLaunch>[1]): Promise<unknown>;
  terminateInstance?(instanceId: string): void;
  dispatchChannelAboutFollowUp?(input: {
    spaceId: string;
    channelId: string;
    requestId: string;
    triggerMessageId?: string;
    successorOfRunId: string;
    actorUserId: string;
  }): Promise<unknown>;
  observeAgentLaunchStage?(stage: string, outcome: "ok" | "error", durationMs: number): void;
  /**
   * Hand committed work to its Channel's coordinator before answering.
   * Best-effort: finalization and reborn also advance on the coordinator's alarm.
   */
  wakeCoordinator?(channelId: string): Promise<void>;
  /** Deliver this machine's pending commands on its socket, behind that socket's frames. */
  deliverPending?(identity: MachineDaemonRouteIdentity): Promise<unknown>;
  /** Retain work that outlives the frame that started it. */
  keepAlive?(task: Promise<unknown>): void;
  quotaChanged?(route: { ownerUserId: string; machineId: string }): Promise<void>;
  /** The daemon connected: wake the Channels whose work waits on this Machine. */
  machineConnected?(route: { ownerUserId: string; machineId: string }): Promise<unknown>;
}

/** Machine Daemon composition whose durable effects are PostgreSQL commands on the owner's Machine and its Runs. */
export class PostgresMachineDaemonPort implements MachineDaemonSocketBackend {
  readonly capabilities = new Set(MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES);
  private readonly activeLeases = new Map<string, MachineCommandLease>();
  private readonly activeRunChannels = new Map<string, string>();
  /** Per machine route: the snapshot fan-out waiting behind the one running. */
  private readonly snapshotFanouts = new Map<string, { next?: () => Promise<void> }>();

  static fromEnv(input: { env: Env; terminateInstance?: (instanceId: string) => void;
    deliverPending?: PostgresMachineDaemonPortDependencies["deliverPending"];
    quotaChanged?: PostgresMachineDaemonPortDependencies["quotaChanged"];
    keepAlive?: (task: Promise<unknown>) => void }): PostgresMachineDaemonPort {
    return new PostgresMachineDaemonPort({
      authenticate: (token) => verifyMachineDaemonCredential(token, input.env),
      daemonCommand: (command) => machineDaemonCommand(input.env, command),
      runLifecycleReport: (report) => machineRunLifecycleReport(input.env, report),
      launchUpdate: (update) => updateAgentLaunch(input.env, update),
      machineConnected: (route) => wakeMachineChannels(input.env, route),
      terminateInstance: input.terminateInstance,
      quotaChanged: input.quotaChanged,
      dispatchChannelAboutFollowUp: (followUp) => dispatchProductChannelAbout({
        env: input.env,
        ...followUp,
        skipDaemonWake: true,
      }),
      observeAgentLaunchStage: (stage, outcome, durationMs) => recordAgentLaunchStage({
        env: input.env, stage, outcome, durationMs,
      }),
      wakeCoordinator: (channelId) => wakeAgentLaunchCoordinator(input.env, channelId),
      ...(input.deliverPending ? { deliverPending: input.deliverPending } : {}),
      ...(input.keepAlive ? { keepAlive: input.keepAlive } : {}),
    });
  }

  constructor(private readonly dependencies: PostgresMachineDaemonPortDependencies) {}

  async authenticate(message: MachineDaemonConnectMessage) {
    const authenticated = await this.dependencies.authenticate(message.token);
    if (message.machineId !== authenticated.machineId) {
      throw new Error("Machine Daemon credential does not match the Machine");
    }
    // A signed credential establishes identity. Connect reports the current,
    // mutable hostname, which may have changed since that credential was minted.
    const principal = { ...authenticated, ...machineHostnameObservation(message) };
    const result = await this.dependencies.daemonCommand(
      machineCommand(principal, message, message.activation ? "recover_connect" : "connect"),
    );
    const activation = result.activation && typeof result.activation === "object" &&
        !Array.isArray(result.activation)
      ? result.activation as Record<string, unknown>
      : undefined;
    // The connect is committed; waking its Channels must not delay or fail it.
    const woken = this.dependencies.machineConnected?.({ ownerUserId: principal.ownerUserId,
      machineId: principal.machineId })?.catch((error: unknown) => console.warn(
      "Machine reconnect could not wake its Channels", { errorCode: error instanceof Error ? error.name : "unknown" }));
    if (woken) this.dependencies.keepAlive?.(woken);
    return {
      principal,
      connected: {
        type: "machine_daemon_connected" as const,
        daemon: serializedDaemon(recordValue(result.daemon, "daemon")),
        connectionEpoch: requiredPositiveInteger(result.connectionEpoch, "connectionEpoch"),
        ...(activation ? { activation: activationReceipt(activation, message.requestId) } : {}),
      },
    };
  }

  async refresh(token: string): Promise<MachineDaemonAuthorityPrincipal> {
    return this.dependencies.authenticate(token);
  }

  async execute(
    session: Readonly<MachineDaemonRuntimeSession>,
    message: ExecutableMessage,
  ): Promise<MachineDaemonServerMessage | undefined> {
    if (message.type === "machine_activation_begin" || message.type === "machine_activation_prepare" ||
        message.type === "machine_activation_advance") {
      const result = await this.dependencies.daemonCommand(sessionCommand(
        session,
        message.type === "machine_activation_begin" ? "activation_begin"
          : message.type === "machine_activation_prepare" ? "activation_prepare" : "activation_advance",
        message,
      ));
      return activationReceipt(recordValue(result.activation, "activation"), message.requestId);
    }
    if (message.type === "machine_command_lease_renew") {
      const controlId = requiredString(message.controlId, "controlId");
      const requestId = requiredString(message.requestId, "requestId");
      const relayLease = messageRelayLease(message);
      if (!relayLease) throw new Error("Machine Daemon command lease renewal requires authority");
      const result = await this.dependencies.daemonCommand({
        ...sessionCommand(session, "renew", message, relayLease),
        controlId,
        leaseMs: 60_000,
      });
      return {
        type: "machine_command_lease_renewed",
        requestId,
        controlId,
        leaseUntil: requiredString(result.leaseUntil, "leaseUntil"),
      };
    }
    if (message.type === "machine_command_admitted") {
      const admissionStarted = performance.now();
      try {
        const controlId = requiredString(message.controlId, "controlId");
        const requestId = requiredString(message.requestId, "requestId");
        const relayLease = messageRelayLease(message);
        if (!relayLease) throw new Error("Machine Daemon admission requires authority lease evidence");
        const result = await this.dependencies.daemonCommand({
          ...sessionCommand(session, "renew", message, relayLease),
          controlId,
          leaseMs: 60_000,
        });
        if (message.launchId && message.channelId) {
          await this.dependencies.launchUpdate({
            launchId: message.launchId,
            channelId: message.channelId,
            actorUserId: session.principal.ownerUserId,
            state: "admitted",
            at: message.admittedAt,
          });
        }
        this.dependencies.observeAgentLaunchStage?.("daemon_admit", "ok",
          performance.now() - admissionStarted);
        return { type: "machine_command_admission_acked", requestId, controlId,
          leaseUntil: requiredString(result.leaseUntil, "leaseUntil") };
      } catch (error) {
        this.dependencies.observeAgentLaunchStage?.("daemon_admit", "error",
          performance.now() - admissionStarted);
        throw error;
      }
    }
    assertMachineRegistryCausality(session, message);
    if (message.type === "machine_harness_action_result" &&
        !session.capabilities.includes(MACHINE_HARNESS_ACTION_CAPABILITY)) {
      throw new Error("Harness action result does not come from a capable connection");
    }
    if (message.type === "machine_quota_probe_result" &&
        (!session.capabilities.includes("machine_quota_probe_v2") ||
          message.probe?.connectionEpoch !== session.connectionEpoch || message.probe?.requestId !== message.requestId)) {
      throw new Error("Quota probe result does not match the capable active connection");
    }
    const action = message.type === "unregister"
      ? "unregister"
      : COMPLETION_EVENTS.has(message.type) ? "complete" : "report";
    const requestId = "requestId" in message && typeof message.requestId === "string"
      ? message.requestId
      : undefined;
    const leaseKey = requestId ? machineLeaseKey(session, requestId) : undefined;
    // Prefer in-memory lease from this Runtime process, but fall back to the
    // exact lease the host echoes. Hibernation clears activeLeases while the
    // reverse socket can rehydrate; without the echo, complete fails closed and
    // the intent stays leased until reap — push delivery looks "stuck".
    const relayLease = action === "complete" && leaseKey
      ? this.activeLeases.get(leaseKey) ?? messageRelayLease(message)
      : undefined;
    const machineControlInput = sessionCommand(session, action, message, relayLease);
    if (message.type === "machine_run_snapshot" && message.registryConnectionEpoch !== undefined &&
        message.registrySequence !== undefined) {
      machineControlInput.commandId = await causalSnapshotCommandId(session, message);
    }
    const result = await this.dependencies.daemonCommand(machineControlInput);
    if (message.type === "machine_quota_probe_result") {
      await this.dependencies.quotaChanged?.({ ownerUserId: session.principal.ownerUserId, machineId: session.principal.machineId });
    }
    if (message.type === "machine_spawn_result" && message.launchId && message.channelId) {
      const spawnStarted = performance.now();
      try {
        await this.dependencies.launchUpdate({
          launchId: message.launchId,
          channelId: message.channelId,
          actorUserId: session.principal.ownerUserId,
          state: message.ok ? "spawned" : "failed",
          at: message.ok ? message.spawnedAt : new Date().toISOString(),
          ...(message.ok ? {} : {
            errorStage: "daemon_spawn",
            errorCode: "daemon_spawn_failed",
            errorMessage: message.error,
            retryable: isRecoverableLaunchFailure(message.error),
          }),
        });
        this.dependencies.observeAgentLaunchStage?.("daemon_spawn", "ok",
          performance.now() - spawnStarted);
      } catch (error) {
        this.dependencies.observeAgentLaunchStage?.("daemon_spawn", "error",
          performance.now() - spawnStarted);
        throw error;
      }
    }
    const runId = "runId" in message && typeof message.runId === "string"
      ? message.runId
      : undefined;
    const messageChannelId = "channelId" in message && typeof message.channelId === "string"
      ? message.channelId
      : undefined;
    const runLifecycleChannelId = optionalString(result.runLifecycleChannelId) ?? messageChannelId ??
      (runId ? this.activeRunChannels.get(runId) : undefined);
    // A committed terminal report is the Authority's to finalize: the
    // coordinator commits the Run lifecycle and issues
    // Channel About successors. The frame answers now instead of holding this
    // socket's order through those round trips.
    const terminalRecorded = result.runTerminalReportRecorded === true;
    if (terminalRecorded) {
      if (runLifecycleChannelId) await this.dependencies.wakeCoordinator?.(runLifecycleChannelId);
      if (runId) this.activeRunChannels.delete(runId);
    } else if (runLifecycleChannelId && runId) {
      const lifecycleResult = await this.dependencies.runLifecycleReport({
        ...sessionCommand(session, "report", message),
        commandId: runtimeCommandId(
          "machine-run-lifecycle",
          `${message.type}:${runId}:${requestId ?? "report"}${result.reused === true
            ? `:completion-reconcile:${session.connectionEpoch}` : ""}`,
        ),
        channelId: runLifecycleChannelId,
        runLifecycleReplica: true,
        ...(result.runLifecycleStopPurpose === "reborn-predecessor"
          ? { runLifecycleStopPurpose: "reborn-predecessor" }
          : {}),
      });
      // The stopped predecessor unblocks its durable reborn successor.
      if (message.type === "machine_stop_result" && result.runLifecycleStopPurpose === "reborn-predecessor") {
        await this.dependencies.wakeCoordinator?.(runLifecycleChannelId);
      }
      await this.dispatchChannelAboutFollowUps(lifecycleResult);
      this.closeCommittedTerminalInstances(lifecycleResult);
      if (message.type === "machine_run_exited" || message.type === "machine_stop_result") {
        this.activeRunChannels.delete(runId);
      }
    }
    if (message.type === "machine_run_snapshot") {
      // A partial snapshot is one Run's progress: it reaches only its Runs'
      // Channels, never retires, and must not be superseded by a later one,
      // so it stays in this frame. A full snapshot fans out off the socket.
      if (message.snapshotComplete === true) this.fanOutSnapshot(session, message, requestId, result);
      else await this.reconcileSnapshotChannels(session, message, requestId, result);
    }
    await this.dispatchChannelAboutFollowUps(result);
    if (action === "complete" && leaseKey) this.activeLeases.delete(leaseKey);
    if (message.type === "machine_request_notice") {
      const messageId = requiredString(
        result.requestNoticeMessageId,
        "requestNoticeMessageId",
      );
      return {
        type: "machine_request_notice_accepted",
        requestId: message.requestId,
        channelId: message.channelId,
        messageId,
      };
    }
    if (action === "complete" && requestId) {
      return {
        type: "machine_command_completion_acked",
        requestId,
        controlId: requestId,
      };
    }
    // Committed means answered: a report no Channel can finalize is acknowledged
    // too, or the daemon would resend it forever.
    if (message.type === "machine_run_exited" && requestId && runId) {
      return { type: "machine_run_report_acked", requestId, runId };
    }
    return message.type === "unregister"
      ? { type: "unregistered", requestId: message.requestId }
      : undefined;
  }

  private closeCommittedTerminalInstances(result: Record<string, unknown>): void {
    if (result.terminalInstanceIds === undefined) return;
    if (!Array.isArray(result.terminalInstanceIds) || result.terminalInstanceIds.length > 10_000 ||
        result.terminalInstanceIds.some(id => typeof id !== "string" || !id || id.length > 300)) {
      throw new Error("Invalid authoritative terminal Instance list");
    }
    for (const id of result.terminalInstanceIds) this.dependencies.terminateInstance?.(id as string);
  }

  /**
   * A complete snapshot reconciles every Channel with a live Run on this
   * machine, one Authority transaction each. Inside the frame that fan-out held
   * the daemon socket's order: with dozens of Channels and a snapshot every few
   * seconds while Runs start, spawn pushes, admissions and terminal reports
   * queued behind it for minutes. The frame now commits only the machine
   * report. The fan-out runs outside the socket's order, one at a time per
   * machine, and a newer snapshot replaces one still waiting. Order across
   * frames stays safe: each Channel's snapshot head accepts only a newer
   * registry sequence, and a snapshot never retires a Run its causal evidence
   * does not cover.
   */
  private fanOutSnapshot(session: Readonly<MachineDaemonRuntimeSession>,
    message: Extract<ExecutableMessage, { type: "machine_run_snapshot" }>, requestId: string | undefined,
    result: Record<string, unknown>): void {
    const work = () => this.reconcileSnapshotChannels(session, message, requestId, result);
    const key = machineDaemonRouteKey(session.principal);
    const waiting = this.snapshotFanouts.get(key);
    if (waiting) { waiting.next = work; return; }
    const lane: { next?: () => Promise<void> } = { next: work };
    this.snapshotFanouts.set(key, lane);
    const drain = (async () => {
      while (lane.next) {
        const run = lane.next;
        lane.next = undefined;
        await run().catch((error: unknown) => console.warn("Machine Daemon snapshot reconciliation failed", {
          machineId: session.principal.machineId,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      this.snapshotFanouts.delete(key);
    })();
    this.dependencies.keepAlive?.(drain);
  }

  private async reconcileSnapshotChannels(session: Readonly<MachineDaemonRuntimeSession>,
    message: Extract<ExecutableMessage, { type: "machine_run_snapshot" }>, requestId: string | undefined,
    result: Record<string, unknown>): Promise<void> {
    const persistedChannels = Array.isArray(result.runLifecycleChannelIds)
      ? result.runLifecycleChannelIds.flatMap((value) => typeof value === "string" ? [value] : [])
      : [];
    const channels = new Set(message.snapshotComplete === true
      ? [...persistedChannels, ...this.activeRunChannels.values()]
      : persistedChannels);
    const snapshotIdentity = message.registryConnectionEpoch !== undefined &&
        message.registrySequence !== undefined
      ? `${message.registryConnectionEpoch}:${message.registrySequence}`
      : requestId ?? crypto.randomUUID();
    const retiredRunIds = new Set<string>();
    let followUps = 0;
    for (const channelId of channels) {
      const lifecycleResult = await this.dependencies.runLifecycleReport({
        ...sessionCommand(session, "report", message),
        commandId: runtimeCommandId(
          "machine-run-snapshot",
          `${channelId}:${snapshotIdentity}`,
        ),
        channelId,
        runLifecycleReplica: true,
      });
      if (Array.isArray(lifecycleResult.changedRunIds)) {
        for (const runId of lifecycleResult.changedRunIds) {
          if (typeof runId === "string") retiredRunIds.add(runId);
        }
      }
      this.closeCommittedTerminalInstances(lifecycleResult);
      followUps += await this.dispatchChannelAboutFollowUps(lifecycleResult);
    }
    for (const retiredRunId of retiredRunIds) this.activeRunChannels.delete(retiredRunId);
    // Successors were issued without a wake; no frame of this socket will
    // catch them up, so deliver them now.
    if (followUps > 0) await this.dependencies.deliverPending?.(session.principal);
  }

  private async dispatchChannelAboutFollowUps(result: Record<string, unknown>): Promise<number> {
    if (!this.dependencies.dispatchChannelAboutFollowUp ||
        !Array.isArray(result.channelAboutFollowUps)) return 0;
    if (result.channelAboutFollowUps.length > 50) {
      throw new Error("PostgreSQL returned oversized Channel About follow-up work");
    }
    for (const item of result.channelAboutFollowUps) {
      const followUp = recordValue(item, "channelAboutFollowUps[]");
      await this.dependencies.dispatchChannelAboutFollowUp({
        spaceId: requiredString(followUp.spaceId, "channelAboutFollowUps[].spaceId"),
        channelId: requiredString(followUp.channelId, "channelAboutFollowUps[].channelId"),
        requestId: requiredString(followUp.requestId, "channelAboutFollowUps[].requestId"),
        successorOfRunId: requiredString(
          followUp.successorOfRunId,
          "channelAboutFollowUps[].successorOfRunId",
        ),
        actorUserId: requiredString(followUp.actorUserId, "channelAboutFollowUps[].actorUserId"),
        ...(followUp.triggerMessageId !== undefined ? { triggerMessageId: requiredString(followUp.triggerMessageId, "channelAboutFollowUps[].triggerMessageId") } : {}),
      });
    }
    return result.channelAboutFollowUps.length;
  }

  async disconnected(session: Readonly<MachineDaemonRuntimeSession>): Promise<void> {
    await this.dependencies.daemonCommand(sessionCommand(session, "unregister"));
  }

  connected(
    session: Readonly<MachineDaemonRuntimeSession>,
    deliver: (message: MachineDaemonServerMessage) => Promise<void>,
  ): Promise<void> {
    // A fresh authenticated connection receives one catch-up claim. New
    // commands are pushed by the issue-commit wake path; this callback must
    // never keep the Runtime Durable Object alive with a recurring timer.
    return this.deliverPendingOnce(session, deliver).then(() => undefined);
  }

  async deliverPendingOnce(
    session: Readonly<MachineDaemonRuntimeSession>,
    deliver: (message: MachineDaemonServerMessage) => Promise<void>,
  ): Promise<number> {
    const commands = await this.claimCommands(session);
    if (commands.length > 5) throw new Error("PostgreSQL returned an oversized Machine Daemon claim");
    let delivered = 0;
    for (const command of commands) {
      try {
        await deliver(command);
        delivered += 1;
      } catch (error) {
        // Claim already advanced Authority to leased. If the reverse frame cannot be
        // written, release immediately so wake/re-connect/HTTP pull can reclaim
        // instead of waiting out the full lease window on a dead push path.
        await this.releaseClaimedCommand(session, command);
        throw error;
      }
    }
    return delivered;
  }

  claimPending(
    session: Readonly<MachineDaemonRuntimeSession>,
    deliver: (message: MachineDaemonServerMessage) => Promise<void>,
  ): Promise<number> {
    return this.deliverPendingOnce(session, deliver);
  }

  async claimCommands(
    session: Readonly<MachineDaemonRuntimeSession>,
    commandTypes: readonly ("spawn" | "stop" | "cleanup" | "request_resolve" | "recover_reply" | "quota_probe" |
      "harness_action")[] = [
      "spawn", "stop", "cleanup", "request_resolve",
    ],
  ): Promise<readonly MachineDaemonServerMessage[]> {
    const claimStarted = performance.now();
    let result: Record<string, unknown>;
    try {
      result = await this.dependencies.daemonCommand({
        ...sessionCommand(session, "report"),
        commandId: runtimeCommandId("machine-claim"),
        action: "claim",
        eventType: undefined,
        commandTypes: [...commandTypes.filter(type => (type !== "quota_probe" || session.capabilities.includes("machine_quota_probe_v2")) &&
            (type !== "harness_action" || session.capabilities.includes(MACHINE_HARNESS_ACTION_CAPABILITY))),
          ...(session.capabilities.includes("reply_recovery_v1") && !commandTypes.includes("recover_reply") ? ["recover_reply"] : []),
          ...(session.capabilities.includes("machine_quota_probe_v2") && !commandTypes.includes("quota_probe") ? ["quota_probe"] : []),
          ...(session.capabilities.includes(MACHINE_HARNESS_ACTION_CAPABILITY) && !commandTypes.includes("harness_action")
            ? ["harness_action"] : [])],
        // Reverse push is primary; lease covers in-flight host execution until
        // complete. Delivery failure must release (see deliverPendingOnce), not rely on
        // shortening this window for bounded HTTP recovery.
        leaseMs: session.capabilities.includes("machine_command_admission_ack_v1") ? 10_000 : 30_000,
        payload: {},
      });
      this.dependencies.observeAgentLaunchStage?.("daemon_claim", "ok", performance.now() - claimStarted);
    } catch (error) {
      this.dependencies.observeAgentLaunchStage?.("daemon_claim", "error",
        performance.now() - claimStarted);
      throw error;
    }
    if (!Array.isArray(result.commands)) {
      throw new Error("PostgreSQL response is missing commands");
    }
    return result.commands.map((item) => {
      const wrapper = recordValue(item, "commands[]");
      const command = claimedCommand(wrapper.payload);
      if (command.type === "machine_quota_probe" &&
          (!session.capabilities.includes("machine_quota_probe_v2") || command.probe.connectionEpoch !== session.connectionEpoch)) {
        throw new Error("Quota probe command does not match the capable active connection");
      }
      if (command.type === "machine_harness_action" && !session.capabilities.includes(MACHINE_HARNESS_ACTION_CAPABILITY)) {
        throw new Error("Harness action command does not match a capable connection");
      }
      const requestId = requiredString(
        command.requestId,
        "commands[].payload.requestId",
      );
      const relayLease = machineCommandLease(wrapper);
      this.activeLeases.set(machineLeaseKey(session, requestId), relayLease);
      const leasedCommand: MachineDaemonLeasedCommand = { ...command, relayLease };
      if ("runId" in command && typeof command.runId === "string" &&
          "channelId" in command && typeof command.channelId === "string") {
        this.activeRunChannels.set(command.runId, command.channelId);
      }
      return leasedCommand;
    });
  }

  private async releaseClaimedCommand(
    session: Readonly<MachineDaemonRuntimeSession>,
    command: MachineDaemonServerMessage,
  ): Promise<void> {
    const requestId = "requestId" in command && typeof command.requestId === "string"
      ? command.requestId
      : undefined;
    if (!requestId) return;
    const leaseKey = machineLeaseKey(session, requestId);
    const relayLease = this.activeLeases.get(leaseKey) ?? messageRelayLease(command);
    this.activeLeases.delete(leaseKey);
    if (!relayLease) return;
    try {
      await this.dependencies.daemonCommand({
        ...sessionCommand(session, "report"),
        commandId: runtimeCommandId("machine-release", requestId),
        action: "retry",
        controlId: requestId,
        eventType: undefined,
        payload: {},
        relayLease,
        backoffMs: 0,
      });
    } catch (error) {
      console.error("Machine Daemon reverse delivery failed to release lease after send error", {
        ownerUserId: session.principal.ownerUserId,
        machineId: session.principal.machineId,
        hostId: session.principal.hostId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

}

function routeIdentityKey(session: Readonly<MachineDaemonRuntimeSession>): string {
  return JSON.stringify([
    session.principal.ownerUserId,
    session.principal.machineId,
    session.principal.hostId,
  ]);
}

async function causalSnapshotCommandId(
  session: Readonly<MachineDaemonRuntimeSession>,
  message: Extract<ExecutableMessage, { type: "machine_run_snapshot" }>,
): Promise<string> {
  const material = `${routeIdentityKey(session)}\0${message.registryConnectionEpoch}\0${message.registrySequence}`;
  const identity = await sha256Hex(material);
  return runtimeCommandId("machine-report-snapshot", identity);
}

type MachineCommandLease = MachineDaemonCommandLease;
type MachineDaemonLeasedCommand =
  | MachineDaemonHarnessActionCommand
  | MachineDaemonQuotaProbeCommand
  | MachineDaemonRecoverReplyCommand
  | MachineDaemonSpawnCommand
  | MachineDaemonStopCommand
  | MachineDaemonRequestResolveCommand
  | MachineDaemonWorktreeCleanupCommand;

function machineLeaseKey(session: Readonly<MachineDaemonRuntimeSession>, requestId: string): string {
  return `${routeIdentityKey(session)}\0${requestId}`;
}

function machineCommandLease(value: Record<string, unknown>): MachineCommandLease {
  const leaseOwner = requiredString(value.leaseOwner, "commands[].leaseOwner");
  const leaseGeneration = Number(value.leaseGeneration);
  const entityVersion = Number(value.entityVersion);
  const daemonEpoch = Number(value.daemonEpoch);
  if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1 ||
      !Number.isSafeInteger(entityVersion) || entityVersion < 2 ||
      !Number.isSafeInteger(daemonEpoch) || daemonEpoch < 1) {
    throw new Error("PostgreSQL returned invalid Machine Daemon lease evidence");
  }
  return { leaseOwner, leaseGeneration, entityVersion, daemonEpoch };
}

function messageRelayLease(message: unknown): MachineCommandLease | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const relayLease = (message as { relayLease?: unknown }).relayLease;
  if (!relayLease || typeof relayLease !== "object" || Array.isArray(relayLease)) return undefined;
  const record = relayLease as Record<string, unknown>;
  const leaseOwner = optionalString(record.leaseOwner);
  const leaseGeneration = Number(record.leaseGeneration);
  const entityVersion = Number(record.entityVersion);
  const daemonEpoch = Number(record.daemonEpoch);
  if (!leaseOwner ||
      !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1 ||
      !Number.isSafeInteger(entityVersion) || entityVersion < 1 ||
      !Number.isSafeInteger(daemonEpoch) || daemonEpoch < 1) {
    return undefined;
  }
  return { leaseOwner, leaseGeneration, entityVersion, daemonEpoch };
}

function assertMachineRegistryCausality(
  session: Readonly<MachineDaemonRuntimeSession>,
  message: ExecutableMessage,
): void {
  const causalSnapshot = message.type === "machine_run_snapshot";
  const causalSpawn = message.type === "machine_spawn_result" && message.ok === true;
  if (!causalSnapshot && !causalSpawn) return;
  const advertised = session.capabilities.includes("machine_run_snapshot_causal_v1");
  const epoch = "registryConnectionEpoch" in message ? message.registryConnectionEpoch : undefined;
  const sequence = "registrySequence" in message ? message.registrySequence : undefined;
  const fieldsPresent = epoch !== undefined || sequence !== undefined ||
    causalSnapshot && message.capturedAt !== undefined;
  if (!advertised && !fieldsPresent) return;
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 1 ||
      causalSnapshot && Number(epoch) !== session.connectionEpoch ||
      causalSpawn && Number(epoch) > session.connectionEpoch ||
      !Number.isSafeInteger(sequence) || Number(sequence) < 1) {
    throw new Error("Machine Daemon registry evidence does not match the active connection");
  }
  if (causalSnapshot) boundedOccurrenceAt(message.capturedAt);
}

function machineCommand(
  principal: MachineDaemonPrincipal,
  message: MachineDaemonConnectMessage,
  action: "connect" | "recover_connect",
): Record<string, unknown> {
  return {
    commandId: runtimeCommandId("machine-connect"),
    action,
    ownerUserId: principal.ownerUserId,
    ownerEmail: principal.ownerEmail,
    machineId: principal.machineId,
    hostId: principal.hostId,
    hostName: principal.hostName,
    hostname: message.hostname,
    displayName: message.displayName,
    capabilities: message.capabilities || [],
    metadata: message.machineMetadata || {},
    payload: { type: "machine_daemon_connect", requestId: message.requestId },
    activation: message.activation,
    principal: machineDaemonCommandPrincipal(principal),
  };
}

function sessionCommand(
  session: Readonly<MachineDaemonRuntimeSession>,
  action: "report" | "complete" | "unregister" | "renew" | "activation_begin" | "activation_prepare" | "activation_advance",
  message?: ExecutableMessage,
  relayLease?: MachineCommandLease,
): Record<string, unknown> {
  const requestId = message && "requestId" in message && typeof message.requestId === "string"
    ? message.requestId
    : undefined;
  if (action === "complete" && !requestId) {
    throw new Error("A leased Machine Daemon command result requires requestId");
  }
  const payload = message ? redactAuditPayload(message) : {};
  return {
    commandId: runtimeCommandId(`machine-${action}`, requestId),
    action,
    ...(action === "complete" ? {
      controlId: requestId,
      success: payload.ok !== false,
      relayLease,
    } : {}),
    ...(action === "renew" ? { relayLease } : {}),
    eventType: action === "renew" ? undefined : message?.type,
    ownerUserId: session.principal.ownerUserId,
    ownerEmail: session.principal.ownerEmail,
    machineId: session.principal.machineId,
    hostId: session.principal.hostId,
    hostName: session.principal.hostName,
    connectionEpoch: session.connectionEpoch,
    displayName: session.displayName,
    capabilities: session.capabilities,
    metadata: session.machineMetadata,
    payload,
    principal: machineDaemonCommandPrincipal(session.principal),
  };
}

function activationReceipt(
  value: Record<string, unknown>,
  requestId: string | undefined,
): Extract<MachineDaemonServerMessage, { type: "machine_activation_receipt" }> {
  const phase = requiredString(value.phase, "activation.phase");
  const runSetDigest = optionalString(value.runSetDigest);
  const expectedRunIds = optionalStringArray(value.expectedRunIds, "activation.expectedRunIds");
  const preparedReceiptId = optionalString(value.preparedReceiptId);
  const activeFencedReceiptId = optionalString(value.activeFencedReceiptId);
  const activeReceiptId = optionalString(value.activeReceiptId);
  if (!["recovering", "activation_prepared", "active_fenced", "active", "stable_granted", "aborted"].includes(phase)) {
    throw new Error("PostgreSQL returned an invalid activation phase");
  }
  return {
    type: "machine_activation_receipt",
    requestId: requiredString(requestId, "requestId"),
    transactionId: requiredString(value.transactionId, "activation.transactionId"),
    artifactSha256: requiredString(value.artifactSha256, "activation.artifactSha256"),
    connectionEpoch: requiredPositiveInteger(value.connectionEpoch, "activation.connectionEpoch"),
    phase: phase as "recovering" | "activation_prepared" | "active_fenced" | "active" | "stable_granted" | "aborted",
    receiptId: requiredString(value.receiptId, "activation.receiptId"),
    ...(runSetDigest ? { runSetDigest } : {}),
    ...(expectedRunIds ? { expectedRunIds } : {}),
    ...(preparedReceiptId ? { preparedReceiptId } : {}),
    ...(activeFencedReceiptId ? { activeFencedReceiptId } : {}),
    ...(activeReceiptId ? { activeReceiptId } : {}),
  };
}

function redactAuditPayload(message: ExecutableMessage): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(message as unknown as Record<string, unknown>)
      .filter(([field]) => !PRIVATE_AUDIT_FIELDS.has(field)),
  );
}

function serializedDaemon(value: Record<string, unknown>): SerializedMachineDaemon {
  const id = requiredString(value.id, "daemon.id");
  const userId = requiredString(value.userId, "daemon.userId");
  const email = requiredString(value.email, "daemon.email");
  const name = requiredString(value.name, "daemon.name");
  const lastSeenAt = requiredString(value.lastSeenAt, "daemon.lastSeenAt");
  const status = requiredString(value.status, "daemon.status");
  if (!isAgentStatus(status)) {
    throw new Error("PostgreSQL returned an invalid daemon.status");
  }
  const machineId = optionalString(value.machineId);
  const hostId = optionalString(value.hostId);
  const hostName = optionalString(value.hostName);
  const hostname = optionalString(value.hostname);
  const activeRuns = typeof value.activeRuns === "number" && Number.isSafeInteger(value.activeRuns)
    && value.activeRuns >= 0 ? value.activeRuns : undefined;
  return {
    id,
    userId,
    email,
    name,
    status: status as SerializedMachineDaemon["status"],
    metadata: {
      ...recordOrEmpty(value.metadata),
      ...(machineId ? { machineId } : {}),
      ...(hostId ? { hostId } : {}),
      ...(hostName ? { hostName } : {}),
      ...(hostname ? { hostname } : {}),
    },
    connectedAt: optionalString(value.firstSeenAt) || lastSeenAt,
    lastSeenAt,
    machineId,
    hostId,
    hostName,
    hostname,
    ...(activeRuns !== undefined ? { activeRuns } : {}),
  };
}

function claimedCommand(value: unknown): MachineDaemonLeasedCommand {
  const payload = recordValue(value, "commands[].payload");
  const type = requiredString(payload.type, "commands[].payload.type");
  const requestId = requiredString(payload.requestId, "commands[].payload.requestId");
  if (type === "machine_harness_action") {
    const action = parseHarnessActionRequest(payload);
    if (action.requestId !== requestId || Object.keys(payload).some(key =>
        !["type", "requestId", "presetId", "action", "code", "relayLease"].includes(key))) {
      throw new Error("PostgreSQL returned an invalid harness action command");
    }
    return { type, requestId, presetId: action.presetId, action: action.action,
      ...(action.code === undefined ? {} : { code: action.code }) };
  }
  if (type === "machine_quota_probe") {
    const probe = parseRoutingQuotaProbeRequest(payload.probe);
    if (probe.requestId !== requestId || Object.keys(payload).some(key =>
        !["type", "requestId", "probe", "relayLease"].includes(key))) {
      throw new Error("PostgreSQL returned an invalid quota probe command");
    }
    return { type, requestId, probe };
  }
  if (type === "machine_spawn_agent") {
    const workspace = recordOrUndefined(payload.workspace);
    if (!workspace || !optionalString(workspace.machineId) ||
        !optionalString(workspace.canonicalCwd) || !optionalString(payload.spaceId) ||
        !optionalString(payload.channelId) ||
        !optionalString(payload.runtime) || !optionalString(payload.agentName) ||
        typeof payload.prompt !== "string" ||
        (payload.instanceId !== undefined && !optionalString(payload.instanceId))) {
      throw new Error("PostgreSQL returned an invalid machine_spawn_agent command");
    }
  } else if (type === "machine_stop_agent") {
    if (![payload.runId, payload.executionKey, payload.agentId, payload.instanceId, payload.pid].some(Boolean)) {
      throw new Error("PostgreSQL returned an invalid machine_stop_agent command");
    }
    if (payload.worktreeDisposition !== undefined &&
        payload.worktreeDisposition !== "retain" && payload.worktreeDisposition !== "abandon") {
      throw new Error("PostgreSQL returned an invalid Machine Daemon worktree disposition");
    }
    if (payload.worktreeDisposition === "abandon" &&
        ![payload.runId, payload.executionKey, payload.instanceId, payload.resumeSessionKey]
          .every((field) => optionalString(field))) {
      throw new Error("PostgreSQL returned an incomplete Machine Daemon abandon command");
    }
    if (payload.worktreeDisposition === "abandon") {
      const repoPoolFields = [
        payload.repoIdentity, payload.repoKeyId, payload.slotId,
      ];
      const suppliedRepoPoolFields = repoPoolFields.filter((field) => field !== undefined).length;
      if (suppliedRepoPoolFields !== 0 &&
          (suppliedRepoPoolFields !== repoPoolFields.length ||
           !repoPoolFields.every((field) => optionalString(field)))) {
        throw new Error("PostgreSQL returned a partial Machine Daemon repo pool authority");
      }
    }
  } else if (type === "machine_recover_reply") {
    if (![payload.runId, payload.instanceId, payload.executionKey, payload.channelId, payload.executionId].every(optionalString)) {
      throw new Error("PostgreSQL returned an invalid recovery command");
    }
  } else if (type === "machine_worktree_cleanup") {
    const workspace = recordOrUndefined(payload.workspace);
    if (!workspace || !optionalString(workspace.machineId) ||
        !optionalString(workspace.canonicalCwd) || !optionalString(payload.channelId) ||
        !optionalString(payload.scopeChannelId) || !optionalString(payload.worktreePath)) {
      throw new Error("PostgreSQL returned an invalid machine_worktree_cleanup command");
    }
  } else if (type === "machine_request_resolve") {
    if (!optionalString(payload.daemonRequestId) || !["approve", "deny"].includes(String(payload.decision))) {
      throw new Error("PostgreSQL returned an invalid machine_request_resolve command");
    }
  } else {
    throw new Error(`PostgreSQL returned unsupported Machine Daemon command ${type}`);
  }
  if (type === "machine_spawn_agent") {
    return withMachineSpawnHarness({ ...payload, type, requestId }) as MachineDaemonSpawnCommand;
  }
  if (type === "machine_stop_agent") {
    return { ...payload, type, requestId } as MachineDaemonStopCommand;
  }
  if (type === "machine_recover_reply") return { ...payload, type, requestId } as MachineDaemonRecoverReplyCommand;
  if (type === "machine_worktree_cleanup") {
    return { ...payload, type, requestId } as MachineDaemonWorktreeCleanupCommand;
  }
  return { ...payload, type: "machine_request_resolve", requestId } as MachineDaemonRequestResolveCommand;
}

function requiredString(value: unknown, field: string): string {
  const clean = optionalString(value);
  if (!clean) throw new Error(`PostgreSQL response is missing ${field}`);
  return clean;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`PostgreSQL returned invalid ${field}`);
  }
  return number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error(`PostgreSQL returned invalid ${field}`);
  }
  const strings = value.map((item) => requiredString(item, field));
  if (new Set(strings).size !== strings.length) {
    throw new Error(`PostgreSQL returned duplicate ${field}`);
  }
  return strings;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return plainRecord(value) ?? {};
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return plainRecord(value);
}
