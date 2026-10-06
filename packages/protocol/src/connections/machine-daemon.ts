import type { MachineHandoffExport, MachineHandoffExportResult } from "../handoff-export.js";
import type { AgentHarnessSpec, AgentRuntimeExecutionEvidence } from "../authority-foundation.js";
import type { RoutingQuotaProbeRequest, RoutingQuotaProbeResponse } from "../agent-routing-quota-probe.js";
import type {
  AgentGoalStatus,
  AgentSandboxMode,
  ChannelAttachment,
  MachineRequestRememberPolicy,
  SerializedMachineDaemon,
  WorkspaceRef,
} from "../authority.js";
import type {
  MachineRequestNoticeAcceptedMessage,
  MachineRequestNoticeMessage,
} from "../machine-request-review.js";

/** First message accepted by the Machine Daemon control-plane endpoint. */
export interface MachineDaemonConnectMessage {
  type: "machine_daemon_connect";
  requestId?: string;
  token: string;
  displayName: string;
  machineId: string;
  /** Operating-system computer name; never an identity or routing key. */
  hostname?: string;
  /** Legacy observation accepted until the supported client cutover. */
  hostId?: string;
  hostName?: string;
  clientVersion?: string;
  protocolVersion?: number;
  capabilities?: string[];
  machineMetadata?: Record<string, unknown>;
  activation?: MachineDaemonActivationConnect;
}

export interface MachineDaemonActivationConnect {
  mode: "recovering" | "rollback";
  transactionId: string;
  transactionNonce: string;
  artifactSha256: string;
  sourceConnectionEpoch: number;
}

export interface MachineDaemonActivationPrepare {
  type: "machine_activation_prepare";
  requestId: string;
  transactionId: string;
  artifactSha256: string;
  connectionEpoch: number;
  runSetDigest: string;
  expectedRunIds: string[];
  adoptedRunIds: string[];
  naturalTerminalRunIds: string[];
  adoptedRuns: MachineDaemonAdoptedRunEvidence[];
}

export interface MachineDaemonActivationBegin {
  type: "machine_activation_begin";
  requestId: string;
  transactionId: string;
  transactionNonce: string;
  artifactSha256: string;
  sourceConnectionEpoch: number;
}

export interface MachineDaemonAdoptedRunEvidence {
  runId: string;
  adoptionKeyHash: string;
  wrapperNonce: string;
  processBirthId: string;
  executableSha256: string;
}

export interface MachineDaemonActivationAdvance {
  type: "machine_activation_advance";
  requestId: string;
  transactionId: string;
  artifactSha256: string;
  connectionEpoch: number;
  phase: "active_fenced" | "active" | "stable_granted" | "abort";
  receiptId?: string;
}

export interface MachineDaemonActivationReceipt {
  type: "machine_activation_receipt";
  requestId: string;
  transactionId: string;
  artifactSha256: string;
  connectionEpoch: number;
  phase: "recovering" | "activation_prepared" | "active_fenced" | "active" | "stable_granted" | "aborted";
  receiptId: string;
  runSetDigest?: string;
  /** Hub-authoritative live Run set captured at Recovering admission. */
  expectedRunIds?: string[];
  preparedReceiptId?: string;
  activeFencedReceiptId?: string;
  activeReceiptId?: string;
}

export interface MachineDaemonSpawnContext {
  /** Exact routed model, enforced before the first task by supporting adapters. */
  requestedModel?: string;
  requestedEffort?: string;
  requestedParameters?: Record<string, string>;
  /** Publication frozen by Message/Runtime authority when the launch is prepared. */
  initialMessageSource?: import("../authority-foundation.js").AgentRuntimeMessageSource;
  /** State captured from the previous live Run when this spawn resumes. */
  goal?: AgentGoalStatus;
}

/**
 * A daemon launch location has no opaque workspace id. Registered directories
 * are identified by machineId + canonicalCwd; managed launches carry the
 * daemon-local managedKey instead.
 */
export interface MachineDaemonSpawnWorkspace {
  managedKey?: string;
  ownerUserId: string;
  machineId: string;
  hostId: string;
  hostName?: string;
  canonicalCwd: string;
  displayName: string;
  runtimesSeen: string[];
  boundChannelIds: string[];
  visibility: "private" | "channel" | "space";
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  metadata?: Record<string, unknown>;
}

/** Opaque Authority lease evidence. Echo only on matching completion or spawn-lease renewal. */
export interface MachineDaemonCommandLease {
  leaseOwner: string;
  leaseGeneration: number;
  entityVersion: number;
  daemonEpoch: number;
}

/** Closed worktree lifecycle intent carried by an exact daemon stop command. */
export type MachineWorktreeDisposition = "retain" | "abandon";

export interface MachineDaemonSpawnCommand {
  type: "machine_spawn_agent";
  requestId: string;
  /** Hub-authoritative registration Space; required for every Run route. */
  spaceId: string;
  runId?: string;
  /** Durable Instance identity bound to this exact host process. */
  instanceId?: string;
  launcherId?: string;
  materializerId?: string;
  executionKey?: string;
  /** Durable launch correlation; ignored by legacy daemons. */
  launchId?: string;
  workspace: MachineDaemonSpawnWorkspace;
  managementSpaceId?: string;
  channelId: string;
  runtime: string;
  runtimeArgs?: string[];
  /** Server-authoritative execution adapter selected from the registration. */
  agentBackend?: "codex-app" | "claude-print" | "zcode-app" | "grok-acp" | "acp" | "pty";
  /** Presentation/config preset identity; legacy daemons may ignore it. */
  agentPresetId?: string;
  /** The Hub's harness preset for this spawn. The daemon uses it instead of
      any preset of its own; legacy daemons ignore it. */
  harness?: AgentHarnessSpec;
  /** Generic ACP subcommand when runtimeArgs do not already provide one. */
  agentAcpArgs?: string[];
  /** Closed host-request review policy copied from the registration. */
  /** Always "off": a daemon released before the sandbox was retired sandboxes a
   * Run unless told otherwise. Current daemons ignore it. */
  sandboxMode?: AgentSandboxMode;
  agentName: string;
  identityId?: string;
  /** The registration's own `instructions`, delivered as the Run's trusted
      initial prompt. The wire name predates the retired Agent Role feature;
      daemons of every version read it, so it keeps this spelling. */
  roleInitialPrompt?: string;
  resume?: boolean;
  resumeInstanceId?: string;
  resumeSessionKey?: string;
  /** Exact retained repo-pool authority. Absent means this is a legacy reborn. */
  repoIdentity?: string;
  repoKeyId?: string;
  slotId?: string;
  /**
   * The historical run predates durable session/worktree identity. The daemon
   * may create one new isolated worktree for this explicit migration only.
   */
  resumeWorktreeBootstrap?: boolean;
  /** Transfer a retained pool slot to a new writer without reset. */
  handoffTransfer?: boolean;
  handoffSourceInstanceId?: string;
  handoffSourceResumeSessionKey?: string;
  context?: MachineDaemonSpawnContext;
  /** @deprecated use context.goal. */
  goal?: AgentGoalStatus;
  runWorktree?: boolean;
  remoteRepo?: string;
  prompt: string;
  attachments?: ChannelAttachment[];
  relayLease?: MachineDaemonCommandLease;
}

export interface MachineDaemonSpawnAuthRequiredReport {
  type: "machine_spawn_auth_required";
  requestId: string;
  runId?: string;
  channelId: string;
  agentName: string;
  identityId?: string;
  verificationUriComplete: string;
  userCode: string;
  expiresIn: number;
}

export interface MachineDaemonSpawnResultReport {
  type: "machine_spawn_result";
  requestId: string;
  launchId?: string;
  runId?: string;
  executionKey?: string;
  instanceId?: string;
  machineId: string;
  canonicalCwd: string;
  channelId: string;
  agentName: string;
  identityId?: string;
  ok: boolean;
  /** Daemon wall-clock time captured immediately after the OS spawn result. */
  spawnedAt?: string;
  /** Active daemon connection that admitted this process into the local registry. */
  registryConnectionEpoch?: number;
  /** Monotonic registry barrier assigned after the process became locally durable. */
  registrySequence?: number;
  pid?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  relayLease?: MachineDaemonCommandLease;
}

export interface MachineDaemonRunExitedReport {
  taskExecution?: { execution?: AgentRuntimeExecutionEvidence; recentExecutions?: AgentRuntimeExecutionEvidence[] };
  operationFailure?: import("../runtime-operation-failure.js").RuntimeOperationFailure;
  wrapperVersion?: string;
  startupSteps?: Array<{ phase: string; atMillis: number }>;
  connectionRetry?: { attempt: number; kind?: "registration" | "channel_join" | "credential_refresh"; nextAttemptAtMillis?: number };
  wrapperReadyAtMillis?: number;
  type: "machine_run_exited";
  requestId?: string;
  runId?: string;
  executionKey?: string;
  agentId?: string;
  agentName?: string;
  pid?: number;
  status?: string;
  exitCode?: number;
  statusPhase?: string;
  runStatusDetail?: string;
  completed?: boolean;
  /** Legacy wrapper hint; never a Channel commit receipt or execution-success requirement. */
  delivered?: boolean;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  /**
   * The daemon ended this idle Run itself so its Instance sleeps until the next
   * Channel message (docs/instance-sleep.md). Absent for every other exit.
   */
  restReason?: "sleeping";
}

export interface MachineDaemonRunSnapshotItem {
  taskExecution?: { execution?: AgentRuntimeExecutionEvidence; recentExecutions?: AgentRuntimeExecutionEvidence[] };
  operationFailure?: import("../runtime-operation-failure.js").RuntimeOperationFailure;
  wrapperVersion?: string;
  /** Bounded first-observed startup checkpoints from this wrapper process. */
  startupSteps?: Array<{ phase: string; atMillis: number }>;
  connectionRetry?: { attempt: number; kind?: "registration" | "channel_join" | "credential_refresh"; nextAttemptAtMillis?: number };
  /** Presentation evidence from the daemon-owned status sidecar. */
  statusPhase?: string;
  wrapperReadyAtMillis?: number;
  runId?: string;
  executionKey?: string;
  agentId?: string;
  agentName?: string;
  pid?: number;
}

export interface MachineDaemonRunSnapshotReport {
  type: "machine_run_snapshot";
  requestId?: string;
  snapshotComplete?: boolean;
  /** Active daemon connection at snapshot capture. */
  registryConnectionEpoch?: number;
  /** Monotonic registry barrier captured while the registry lock was held. */
  registrySequence?: number;
  /** Diagnostic wall-clock timestamp; ordering is defined by registrySequence. */
  capturedAt?: string;
  machineResources?: import("../agent-routing.js").MachineResourceObservation;
  /** Additive, bounded observation; older Hubs ignore this field. */
  harnessInventory?: import("../harness-management.js").HarnessInventory;
  runs: MachineDaemonRunSnapshotItem[];
}

export interface MachineDaemonStopCommand {
  type: "machine_stop_agent";
  requestId: string;
  runId?: string;
  executionKey?: string;
  agentId?: string;
  instanceId?: string;
  /** Durable session/worktree identity; required for an abandon authority. */
  resumeSessionKey?: string;
  /** Credential-free canonical repo identity used to locate the retained pool manifest. */
  repoIdentity?: string;
  repoKeyId?: string;
  slotId?: string;
  pid?: number;
  reason?: string;
  /** The stopped Instance id remains reusable by one acknowledged reborn. */
  preserveInstanceForReborn?: boolean;
  /** Missing is legacy-compatible retain. Only explicit abandon may return a pooled slot. */
  worktreeDisposition?: MachineWorktreeDisposition;
  /** Push the checkout to a handoff branch after the stop (`retain` only). */
  handoffExport?: MachineHandoffExport;
  relayLease?: MachineDaemonCommandLease;
}

export interface MachineDaemonStopResultReport {
  type: "machine_stop_result";
  requestId: string;
  runId?: string;
  executionKey?: string;
  agentId?: string;
  instanceId?: string;
  resumeSessionKey?: string;
  repoIdentity?: string;
  repoKeyId?: string;
  slotId?: string;
  /** Echoes the closed lifecycle intent that was actually applied. */
  worktreeDisposition?: MachineWorktreeDisposition;
  ok: boolean;
  pid?: number;
  /** Stable, non-sensitive host outcome; omitted by legacy daemons. */
  cleanupReason?: "process_terminated" | "already_absent";
  error?: string;
  /** What became of the stop's `handoffExport`; omitted by daemons that predate it. */
  handoffExport?: MachineHandoffExportResult;
  relayLease?: MachineDaemonCommandLease;
}

export interface MachineDaemonRecoverReplyCommand {
  type: "machine_recover_reply";
  requestId: string;
  runId: string;
  instanceId: string;
  executionKey: string;
  channelId: string;
  executionId: string;
  messageId?: string;
  relayLease?: MachineDaemonCommandLease;
}
export interface MachineDaemonRecoverReplyResultReport extends Omit<MachineDaemonRecoverReplyCommand, "type" | "messageId"> {
  type: "machine_recover_reply_result";
  ok: boolean;
  result: {
    status: "committed" | "selection_required" | "unavailable";
    messageId?: string;
    candidates?: Array<{ messageId: string; createdAt: number }>;
    code?: string;
  };
}

export interface MachineDaemonWorktreeCleanupCommand {
  type: "machine_worktree_cleanup";
  requestId: string;
  workspace: WorkspaceRef;
  channelId: string;
  scopeChannelId: string;
  worktreePath: string;
  branch?: string;
  baseRef?: string;
  reason: "channel-deleted" | "channel-archived";
  relayLease?: MachineDaemonCommandLease;
}

export interface MachineDaemonWorktreeCleanupResultReport {
  type: "machine_worktree_cleanup_result";
  requestId: string;
  workspace: WorkspaceRef;
  channelId: string;
  scopeChannelId?: string;
  ok: boolean;
  removed?: boolean;
  needsCleanup?: boolean;
  error?: string;
  relayLease?: MachineDaemonCommandLease;
}

export interface MachineDaemonRequestResolveCommand {
  type: "machine_request_resolve";
  requestId?: string;
  daemonRequestId: string;
  decision: "approve" | "deny";
  remember?: MachineRequestRememberPolicy;
  secretGrantId?: string;
  resolvedBy: string;
  resolvedByLabel?: string;
  relayLease?: MachineDaemonCommandLease;
}

export interface MachineDaemonRequestResolveResultReport {
  type: "machine_request_resolve_result";
  requestId?: string;
  daemonRequestId: string;
  machineId?: string;
  hostId?: string;
  ok: boolean;
  status?: string;
  error?: string;
  relayLease?: MachineDaemonCommandLease;
}

/** Live-socket lease proof. HTTP `/api/daemon/command-lease/renew` is fallback only. */
export interface MachineDaemonCommandLeaseRenew {
  type: "machine_command_lease_renew";
  requestId: string;
  /** Spawn/stop control id that owns the lease. */
  controlId: string;
  /**
   * HTTP fallback admission carries the durable Launch identity while using
   * the same fenced lease-renewal authority as the socket acknowledgement.
   */
  launchId?: string;
  channelId?: string;
  relayLease: MachineDaemonCommandLease;
}

export interface MachineDaemonCommandLeaseRenewed {
  type: "machine_command_lease_renewed";
  requestId: string;
  controlId: string;
  leaseUntil: string;
}

/** Persisted in the daemon effect journal before any host side effect. */
export interface MachineDaemonCommandAdmitted {
  type: "machine_command_admitted";
  requestId: string;
  controlId: string;
  launchId?: string;
  channelId?: string;
  /** Daemon wall-clock time captured after the effect journal became durable. */
  admittedAt?: string;
  relayLease: MachineDaemonCommandLease;
}

export interface MachineDaemonCommandAdmissionAcked {
  type: "machine_command_admission_acked";
  requestId: string;
  controlId: string;
  leaseUntil: string;
}

export interface MachineDaemonCommandCompletionAcked {
  type: "machine_command_completion_acked";
  requestId: string;
  controlId: string;
}

/** Additive receipt: terminal Run authority and downstream finalization succeeded. */
export interface MachineDaemonRunReportAcked {
  type: "machine_run_report_acked";
  requestId: string;
  runId: string;
}

export interface MachineDaemonQuotaProbeCommand {
  type: "machine_quota_probe";
  requestId: string;
  probe: RoutingQuotaProbeRequest;
  relayLease?: MachineDaemonCommandLease;
}

export interface MachineDaemonHarnessActionCommand {
  type: "machine_harness_action";
  requestId: string;
  presetId: string;
  action: import("../harness-management.js").HarnessAction;
  /** Only on `login_finish`. */
  code?: string;
  relayLease?: MachineDaemonCommandLease;
}

export interface MachineDaemonHarnessActionResultReport {
  type: "machine_harness_action_result";
  requestId: string;
  result: import("../harness-management.js").HarnessActionResult;
  relayLease?: MachineDaemonCommandLease;
}

export interface MachineDaemonQuotaProbeResultReport {
  type: "machine_quota_probe_result";
  requestId: string;
  probe: RoutingQuotaProbeResponse;
  relayLease?: MachineDaemonCommandLease;
}

export type MachineDaemonClientMessage =
  | MachineDaemonHarnessActionResultReport
  | MachineDaemonQuotaProbeResultReport
  | MachineDaemonConnectMessage
  | { type: "ping"; requestId?: string }
  | { type: "refresh_auth"; requestId?: string; token: string }
  | { type: "unregister"; requestId?: string }
  | MachineDaemonSpawnAuthRequiredReport
  | MachineDaemonSpawnResultReport
  | MachineDaemonRunExitedReport
  | MachineDaemonRunSnapshotReport
  | MachineDaemonStopResultReport
  | MachineDaemonRequestResolveResultReport
  | MachineRequestNoticeMessage
  | MachineDaemonWorktreeCleanupResultReport
  | MachineDaemonRecoverReplyResultReport
  | MachineDaemonCommandLeaseRenew
  | MachineDaemonCommandAdmitted
  | MachineDaemonActivationBegin
  | MachineDaemonActivationPrepare
  | MachineDaemonActivationAdvance;

type MachineDaemonError = { requestId?: string; message: string; failure?: import("../runtime-operation-failure.js").RuntimeOperationFailure } & { type: "error" };
type MachineDaemonPong = { ts: string; requestId?: string } & { type: "pong" };
type MachineDaemonAuthRefreshed = { ts: string; requestId?: string } & {
  type: "auth_refreshed";
};
type MachineDaemonUnregistered = { requestId?: string } & { type: "unregistered" };
type MachineDaemonShutdown = { reason?: string } & { type: "shutdown_requested" };

export type MachineDaemonServerMessage =
  | MachineDaemonHarnessActionCommand
  | MachineDaemonQuotaProbeCommand
  | MachineDaemonError
  | MachineDaemonPong
  | MachineDaemonAuthRefreshed
  | MachineDaemonUnregistered
  | MachineDaemonShutdown
  | { type: "machine_daemon_connected"; daemon: SerializedMachineDaemon; connectionEpoch: number; activation?: MachineDaemonActivationReceipt }
  | MachineDaemonSpawnCommand
  | MachineDaemonStopCommand
  | MachineDaemonRequestResolveCommand
  | MachineDaemonRequestResolveResultReport
  | MachineRequestNoticeAcceptedMessage
  | MachineDaemonWorktreeCleanupCommand
  | MachineDaemonRecoverReplyCommand
  | MachineDaemonCommandLeaseRenewed
  | MachineDaemonCommandAdmissionAcked
  | MachineDaemonCommandCompletionAcked
  | MachineDaemonRunReportAcked
  | MachineDaemonActivationReceipt;
