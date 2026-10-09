export const AGENT_LAUNCH_STATES = [
  "prepared",
  "queued",
  "admitted",
  "spawned",
  "connected",
  "failed",
  "cancelled",
] as const;

export type AgentLaunchState = typeof AGENT_LAUNCH_STATES[number];

export interface SerializedAgentLaunch {
  launchId: string;
  channelId: string;
  sourceMessageId: string;
  targetName?: string;
  targetAvatarUrl?: string;
  launchKind: string;
  /** Original invocation address, presentation only; never execution authority. */
  sourceMention?: string;
  /** How this environment was chosen, and the candidates that decision saw. Presentation only. */
  routingDecision?: RoutingDecisionEvidence;
  /** Run-owned evidence, separate from the historical launch state. */
  activity?: AgentLaunchActivity;
  runId: string;
  instanceId: string;
  state: AgentLaunchState;
  attempt: number;
  retryable: boolean;
  daemonOffline?: boolean;
  errorStage?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  triggerCommittedAt?: string;
  interpretStartedAt?: string;
  preparedAt?: string;
  commandDurableAt?: string;
  wakeRequestedAt?: string;
  admittedAt?: string;
  spawnedAt?: string;
  connectedAt?: string;
  lastReconciledAt?: string;
  firstReplyAt?: string;
}

/** Safe, bounded projection of the exact Run associated with a launch. */
export interface AgentLaunchActivity {
  repositoryBaseline?: import("./repository-baseline.js").RepositoryBaseline;
  runStatus: string;
  instanceStatus?: string;
  hostName?: string;
  updatedAt: string;
  finishedAt?: string;
  /** Daemon-authenticated local phase; absent on older clients. */
  phase?: string;
  operationFailure?: import("./runtime-operation-failure.js").RuntimeOperationFailure;
  startupSteps?: Array<{ phase: string; at: string }>;
  connectionRetry?: { attempt: number; kind?: "registration" | "channel_join" | "credential_refresh"; nextAttemptAt?: string };
  observedAt?: string;
  evidenceStale?: boolean;
  /** Wrapper registered and joined its Channel, not model execution readiness. */
  wrapperReadyAt?: string;
  wrapperVersion?: string;
  errorCode?: string;
  diagnosticId?: string;
}

/** Recent, committed preparation outcome. No Run/Instance is fabricated for a rejection. */
export interface SerializedAgentInvocationRejection {
  invocationId: string;
  channelId: string;
  sourceMessageId: string;
  sourceMention: string;
  targetRef: string;
  code: string;
  message: string;
  routingDecision?: RoutingDecisionEvidence;
  rejectedAt: string;
  evidenceExpiresAt: string;
}

export interface AgentInvocationQueryPage {
  launches: SerializedAgentLaunch[];
  rejections?: SerializedAgentInvocationRejection[];
  /** Present for paginated readers. Missing on an older Hub. */
  nextCursor?: string | null;
  /** Successor Runs created by reborn/handoff, without inventing Launch records. */
  continuations?: import("./agent-continuation.js").SerializedAgentContinuation[];
  targets?: import("./agent-message-target.js").SerializedAgentMessageTarget[];
  executions?: import("./agent-message-execution.js").SerializedAgentMessageExecution[];
  /** First-page only: the launch choice a new conversation's first message offers. */
  launchChoices?: SerializedFirstMessageLaunchChoice[];
  /** First-page only: stop commands in this selection, one row per fenced Run. */
  stops?: import("./agent-stop-command.js").SerializedAgentStop[];
}

/** How long a new conversation's first message waits for its author to choose
 * which harness starts (or that none does) before Jev's reading decides. It
 * counts from when its author sees Jev's reading, not from sending. */
export const FIRST_MESSAGE_LAUNCH_WINDOW_MS = 3_000;

/** Jev's reading reaches the author's screen on their next refresh; the Hub
 * allows that long on top of the window when it writes the reading. */
export const FIRST_MESSAGE_LAUNCH_SEEN_MS = 1_500;

/** The window never closes later than this after sending, however late Jev
 * reads or the author looks. */
export const FIRST_MESSAGE_LAUNCH_HOLD_LIMIT_MS = 30_000;

/** A new conversation's first message that summons nobody. Its author may
 * choose a harness or "none" until the window closes; Jev reads the message
 * meanwhile and its reading decides once the window closes unchosen. A
 * harness decided is summoned by an ordinary `@<harness>` reply. */
export interface SerializedFirstMessageLaunchChoice {
  channelId: string;
  messageId: string;
  deadlineAt: string;
  /** The Hub's own clock says the author may still choose. */
  open?: boolean;
  /** Jev's reading, as soon as it has one. */
  recommendation?: { start: true; harness: string } | { start: false };
  /** The decision: the author's choice, or Jev's reading once the window closed. */
  choice?: { start: true; harness: string; by: "author" | "jev"; at: string } | { start: false; by: "author" | "jev"; at: string };
  /** Jev could not read the message, so nothing was decided. */
  failureCode?: string;
}

export interface InvocationDiagnosticsReport {
  schemaVersion: 1;
  generatedAt: string;
  serverVersion?: { id: string; tag?: string };
  channelId: string;
  sourceMessageIds: string[];
  selection: { kind: "recent-messages" | "messages" | "run"; limit: number; hasOlderMessages: boolean };
  run?: { runId: string; instanceId?: string; name?: string; activity: AgentLaunchActivity };
  launches: Array<Omit<SerializedAgentLaunch, "sourceMention" | "errorMessage" | "targetAvatarUrl">>;
  rejections: Array<Omit<SerializedAgentInvocationRejection, "sourceMention">>;
  continuations: Array<Omit<import("./agent-continuation.js").SerializedAgentContinuation, "sourceMention" | "targetAvatarUrl">>;
  targets?: Array<Omit<import("./agent-message-target.js").SerializedAgentMessageTarget, "sourceBodyHash" | "sourceMention">>;
  executions?: Array<Omit<import("./agent-message-execution.js").SerializedAgentMessageExecution, "sourceBodyHash">>;
  nextCursor: string | null;
}

/** Historical decision evidence, never authorization or proof of process startup.
 * Optional fields keep previously stored decisions readable. */
export interface RoutingDecisionEvidence {
  parameters?: import("./launch-parameter-evidence.js").LaunchParameterEvidence;
  source: import("./agent-routing.js").RoutingDecisionSource;
  evaluatedAt?: string;
  fallbackReason?: "jev-abstained" | "jev-unavailable";
  candidateCount?: number;
  rows?: import("./agent-routing.js").RoutingChoiceRow[];
  /** The Machine headroom routing bound. Presentation of the decision, not a new authority. */
  machine?: import("./agent-routing.js").RoutingBoundMachine;
}
