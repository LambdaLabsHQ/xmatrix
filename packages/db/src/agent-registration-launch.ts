import { RegistrationPreparationAuthority } from "./registration-preparation-authority.js";
import { hostnameMetadata } from "./hostname-metadata.js";
import { registrationRepository, summonRepositoryCatalog,
  type RegistrationRepositoryCatalog } from "./registration-repository-authority.js";
import { ACTIVE_RUN_STATUS_SQL,
  agentLaunchExecutable,
  AUTO_LAUNCH_FIELDS,
  agentPresetForLauncher,
  digestCanonicalCloneCborV1,
  isTerminalRunStatus,
  parseSpaceAgentRegistrationKey,
  parseSpaceAgentConfiguration,
  REGISTRATION_PREPARATION_REJECTION_CODES,
  canonicalRegistrationHarness,
  repoSummonReference,
  parseRegistrationResourceLimits,
  parseAgentRoutingRequirements,
  selectionLaunchConditions,
  sameAgentRegistration,
  type SpaceAgentRegistrationKey,
  type AgentRoutingRequirements,
  type RegistrationLaunchBinding,
  registrationLaunchBindingForDaemon,
  parseAgentRegistrationEnvironment,
  routingModelCatalogObservation,
  hostObservedRequirements,
  machineResourceObservation,
  machineMentionValue, machineTagSelects,
  type MachineResourceObservation,
  type RoutingModelOption,
  type RoutingQuotaWindow,
  type HarnessParameter,
  harnessParameterObservation,
  launchHarnessParameters,
  launchRefusalCode,
  validateHarnessParameterValues,
  type AutoLaunchTags,
  type LaunchMachineBlock,
  type LaunchParameterEvidence,
  type AgentRegistrationLaunch, utf8ByteLength, hasControlCharacter,
  currentRoutingQuotaWindows,
} from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { registrationInstructionsSpawnFields } from "./registration-instructions-spawn.js";
import { spaceRulesSpawnFields } from "./space-rules-spawn.js";
import { RegistrationAccessError, registrationRouteRefusal } from "./agent-registration-errors.js";
import { PostgresRegistrationExecutionRepository } from "./agent-registration-execution.js";
import { requireRegistrationAdmission } from "./agent-registration-access.js";
import { REGISTRATION_KEY_SQL, registrationKeyValues } from "./agent-registration-rows.js";
import { currentRegistrationQuotaJoin, registrationQuotaReading } from "./agent-registration-quota-probe.js";
import { messageAuthoredForActor, readMessageInvocationSelections } from "./message-invocation-selections.js";
import { initialMessageSource, withInitialMessageSource } from "./runtime-initial-input.js";
import { MessageAuthorityError } from "./message-authority-error.js";
import { lockChannelLifecycle } from "./channel-capability-policy.js";
import { instanceOrdinalFor, reserveNaturalKey } from "./natural-keys.js";
import { commitRuntime } from "./runtime-control.js";

interface LaunchRequest {
  commandId: string; actorUserId: string; channelId: string;
  /** Present when a Human message carries the invocation; that message then
   * fences the launch. Any other input launches on registration authority alone. */
  sourceMessageId?: string;
  selectionIndex: number; body: string; key: SpaceAgentRegistrationKey;
  requirements: AgentRoutingRequirements;
  modelResource?: string;
  /** Omit model/effort overrides when no runtime model observation exists. */
  useRuntimeDefaultModel?: true;
  /** Absent means a private managed directory with no registered workspace. */
  workspaceReference?: string;
  /** Host abilities the routed daemon must currently report (e.g. `github`). */
  requiredHostCapabilities?: string[];
  /** Caller context copied onto the Run; launch-owned keys always win. */
  runMetadata?: Record<string, unknown>;
  /** Caller-owned Run/Instance identities, e.g. a schedule occurrence's. */
  runId?: string; instanceId?: string;
  /** A Channel About session: a background Run with no Channel Instance, in a
   * private directory of its own that reads its Channel on demand. */
  aboutSession?: RegistrationAboutSession;
  /** The message this launch answers; its wrapper acknowledges it. Not a fence. */
  initialMessageId?: string;
  /** The Channel message this launch is drawn on. Not a fence, and not part of
   * the request identity: a retry of a launch staged before it still matches. */
  presentationMessageId?: string;
  /** Privacy-safe evidence for the selected model/effort and workspace. */
  parameterEvidence?: LaunchParameterEvidence;
  /** Owner's name for the Machine headroom routing bound. A hostname is not a name. */
  machineName?: string;
}

/** One Channel About session per Channel; a new trigger joins the serving session. */
/**
 * A Channel About session that finished its turn but still runs. Only its
 * daemon can end the process, so the caller issues the stop.
 */
export interface ChannelAboutSessionStopTarget {
  runId: string; channelId: string; sessionId: string; executionKey?: string;
  machineOwnerUserId: string; machineId: string; hostId: string;
}

function aboutSessionStopTarget(candidate: QueryResultRow): ChannelAboutSessionStopTarget | undefined {
  const body = candidate.metadata_json ?? {};
  const field = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  const sessionId = field(body.runtimeSessionId);
  const machineOwnerUserId = field(candidate.machine_owner_user_id);
  const machineId = field(body.machineId);
  const hostId = field(body.hostname) ?? field(body.hostId) ?? "";
  const channelId = field(candidate.channel_id);
  if (!sessionId || !machineOwnerUserId || !machineId || !channelId) return undefined;
  const executionKey = field(body.executionKey);
  return { runId: String(candidate.run_id), channelId, sessionId, machineOwnerUserId, machineId, hostId,
    ...(executionKey ? { executionKey } : {}) };
}

function withRetiredAboutSessions<T extends object>(launch: T, retired: ChannelAboutSessionStopTarget[]) {
  return retired.length ? { ...launch, retiredAboutSessions: retired } : launch;
}

/** Invocation phases after which a Channel About session has nothing left to do. */
const ABOUT_SESSION_DONE_PHASES = new Set([
  "turn_completed", "turn_failed", "turn_interrupted", "turn_unknown",
  "wrapper_startup_failed", "run_delivery_failed",
]);

export interface RegistrationAboutSession { triggerMessageId?: string; triggerRequestId: string; successorOfRunId?: string }

export interface RegistrationLaunchCandidate {
  key: SpaceAgentRegistrationKey;
  description: string;
  models: string[];
  modelCatalog?: RoutingModelOption[];
  parameters?: HarnessParameter[];
  parameterModel?: string;
  supportsRequestedEffort?: boolean;
  supportsRequestedParameters?: boolean;
  modelAliases?: Record<string, string>;
  observations?: {
    evaluatedAt: string; machineResources?: MachineResourceObservation;
    outstandingMachineAllocations: number; outstandingRegistrationAllocations: number;
    quota: { remainingPercent: number; assumed: boolean; observedAt?: string; expiresAt?: string; source?: string;
      windows?: RoutingQuotaWindow[] };
  };
  workspaceReferences: string[];
  workspaces: Array<{ reference: string; canonicalCwd?: string; repo?: string; description: string; machineId: string }>;
  /** Host name a `machine:` tag may name instead of the machine id. */
  machineName?: string;
  /** Its owner keeps the Machine out of automatic assignment: only a launch
   * that names the Machine may run here. Absent when the launch named it. */
  autoAssign?: false;
}
export type RegistrationLaunchChooser = (input: {
  message: string; sourceSequence?: number; tags: AutoLaunchTags; candidates: RegistrationLaunchCandidate[];
  /** Registrations seen but not offered, so an empty list can name the real cause. */
  blocked?: readonly LaunchMachineBlock[];
  /** The input needs no repository, so a private managed directory is a valid choice. */
  managedWorkspace?: boolean;
  /** The mention being decided, when a message launches: Jev first reads
   * whether its author is asking an Agent to start, unless `launch:force`. */
  summon?: { text: string; start: number; end: number; authorKind: "user" | "agent" };
  /** A message that summons nobody: Jev first reads whether its author wants
   * an Agent to start now. */
  askToStart?: true;
  /** Told the harness as soon as Jev has read it, before the rest is chosen. */
  onHarness?: (harness: string) => Promise<void>;
}) => Promise<{ key: SpaceAgentRegistrationKey; model: string; modelResource?: string; effort?: string; parameters?: Record<string, string>; useRuntimeDefaultModel?: true;
  workspaceReference?: string; parameterEvidence?: LaunchParameterEvidence }>;

/** The Machine routing bound, recorded so the summon can show `machine:` the way it shows Jev's choices. */
function boundMachine(machineId: string, machineName: string | undefined): { id: string; name?: string } {
  const presented = machineName ? machineMentionValue(machineId, machineName) : undefined;
  const name = presented && presented !== machineId && !presented.startsWith("machine:") ? presented : undefined;
  return { id: machineId, ...(name ? { name } : {}) };
}

const text = (value: string, maximum = 300) => {
  if (typeof value !== "string" || !value || value !== value.trim() || utf8ByteLength(value) > maximum ||
    hasControlCharacter(value)) throw new RegistrationAccessError("invalid_registration_launch", 400);
  return value;
};
/** A Jev choice becomes launch parameters; the chosen registration fixes the harness. */
/** The runtime default names no model and requests no model resource. Any
 * named model must be one of the candidate's allowed models, compared
 * literally; an empty list allows none. */
function selectedModelGranted(candidate: RegistrationLaunchCandidate, selected: { model: string; modelResource?: string; useRuntimeDefaultModel?: true }) {
  if (selected.useRuntimeDefaultModel) return selected.model === "" && !selected.modelResource;
  return candidate.models.includes(selected.modelResource ?? selected.model);
}

function sameHarnessParameterValues(left: Record<string, string>, right: Record<string, string>): boolean {
  return Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([id, value]) => right[id] === value);
}

/** The chooser cannot add, drop or reinterpret the author's parameter values. */
function validateSelectedHarnessParameters(candidate: RegistrationLaunchCandidate,
  selected: Awaited<ReturnType<RegistrationLaunchChooser>>, tags: AutoLaunchTags): void {
  try {
    const authored = launchHarnessParameters(tags), chosen = selected.parameters ?? {};
    if (Object.keys(chosen).length && !candidate.supportsRequestedParameters) throw new Error("Daemon cannot validate parameters");
    validateHarnessParameterValues(candidate.parameters, chosen);
    if (!sameHarnessParameterValues(authored, chosen) ||
        Object.keys(chosen).length && candidate.parameterModel && !selected.useRuntimeDefaultModel &&
          (candidate.modelAliases?.[selected.model] ?? selected.model) !== candidate.parameterModel) throw new Error("Selection mismatch");
  } catch { throw new RegistrationAccessError("registration_selection_invalid", 409); }
}

const selectedParameters = (selected: Awaited<ReturnType<RegistrationLaunchChooser>>, harness: string) => ({
  ...(selected.modelResource ? { modelResource: selected.modelResource } : {}),
  ...(selected.useRuntimeDefaultModel ? { useRuntimeDefaultModel: true as const } : {}),
  ...(selected.parameterEvidence ? { parameterEvidence: selected.parameterEvidence } : {}),
  requirements: { ...(selected.parameters ? { parameters: selected.parameters } : {}), model: selected.model, ...(selected.effort ? { effort: selected.effort } : {}),
    unattended: false, requiredCapabilities: [], harness } });

/** Internal composition boundary: Space admission, global resource reservation,
 * then one Space transaction creating Run + binding + Instance + Launch. A lost
 * commit response keeps the exact intent/reservation for reconciliation. */

/** The executable is the machine owner's declared launch, else the harness
 * preset's runtime. A harness key (`claude_code`) is never an executable: a
 * declared one (copied from a legacy Profile) resolves to its preset's runtime,
 * and an unknown harness is refused rather than exec'd by name. */
function registrationLaunchRuntime(launch: AgentRegistrationLaunch | undefined, harness: string): string {
  if (launch) return agentLaunchExecutable(launch.runtime);
  const runtime = agentPresetForLauncher(harness)?.runtime;
  if (!runtime) throw new RegistrationAccessError("registration_runtime_unknown", 409);
  return runtime;
}

/** How the Hub starts this harness on the machine, as spawn fields. The daemon
 * keeps no installation record and fills gaps from the Hub preset, which it
 * requires to name the registration's harness; a declared runtime (e.g. an
 * absolute path) need not resolve to a preset, so the harness names it. */
export function registrationLaunchSpawnFields(launch: AgentRegistrationLaunch | undefined, harness: string) {
  return { runtime: registrationLaunchRuntime(launch, harness), agentPresetId: harness,
    ...(launch?.runtimeArgs.length ? { runtimeArgs: launch.runtimeArgs } : {}),
    ...(launch?.backend ? { agentBackend: launch.backend } : {}),
    ...(launch?.acpArgs?.length ? { agentAcpArgs: launch.acpArgs } : {}),
    // A daemon released before the sandbox was retired sandboxes unless told not to.
    sandboxMode: "off" as const };
}

export class PostgresRegistrationLaunchRepository extends RegistrationPreparationAuthority {

  async prepare(raw: LaunchRequest) {
    const key = parseSpaceAgentRegistrationKey(raw.key), requirements = parseAgentRoutingRequirements(raw.requirements);
    if (key.spaceId !== this.placement.spaceId || requirements.harness && requirements.harness !== key.harness ||
      !Number.isSafeInteger(raw.selectionIndex) || raw.selectionIndex < 0 || raw.selectionIndex >= 32) {
      throw new RegistrationAccessError("invalid_registration_launch", 400);
    }
    if (raw.useRuntimeDefaultModel !== undefined && (raw.useRuntimeDefaultModel !== true || requirements.effort)) {
      throw new RegistrationAccessError("invalid_registration_launch", 400);
    }
    if (!requirements.model && !raw.useRuntimeDefaultModel || raw.useRuntimeDefaultModel && (requirements.model || raw.modelResource)) {
      throw new RegistrationAccessError("invalid_registration_launch", 400);
    }
    if (Object.hasOwn(raw, "oneshot")) throw new RegistrationAccessError("invalid_registration_launch", 400);
    // `repositoryAuthorization` is retired and never read; it stays in the
    // request identity so a launch staged while it was written still replays.
    const input = { ...raw, key, requirements, repositoryAuthorization: (raw as { repositoryAuthorization?: unknown }).repositoryAuthorization, commandId: text(raw.commandId, 200), actorUserId: text(raw.actorUserId),
      channelId: text(raw.channelId),
      sourceMessageId: raw.sourceMessageId === undefined ? undefined : text(raw.sourceMessageId),
      presentationMessageId: raw.presentationMessageId === undefined ? undefined : text(raw.presentationMessageId),
      workspaceReference: raw.workspaceReference === undefined ? undefined : text(raw.workspaceReference) };
    const bodyHash = await digestCanonicalCloneCborV1(input.body);
    // The summon text is a slice of the hashed body at this selection, so it
    // adds nothing to the request identity; a launch staged before it was
    // recorded still replays. Where the launch is drawn is the same kind of
    // fact: a handoff staged before that link existed still recovers.
    const { runMetadata: callerMetadata, presentationMessageId: _shownOn, ...identity } = input;
    const { sourceMention: _summon, ...runMetadata } = callerMetadata ?? {};
    const requestDigest = await digestCanonicalCloneCborV1({ ...identity, body: bodyHash,
      ...(Object.keys(runMetadata).length ? { runMetadata } : {}) });
    const intent = await this.database.transaction({ requestId: input.commandId, operation: "registration.launch.stage",
      placement: this.placement }, async tx => {
      const source = await this.source(tx, input);
      await tx.query({ name: "registration_launch_command_lock_v1", text: `SELECT pg_advisory_xact_lock(
        hashtextextended(jsonb_build_array('registration-launch',$1::text,$2::text)::text,0))`,
      values: [input.actorUserId,input.commandId], maxRows: 1 });
      const prior = await tx.query({ name: "registration_launch_existing_v1", text: `SELECT * FROM data.registration_launch_intents
        WHERE actor_user_id=$1 AND command_id=$2 FOR UPDATE`, values: [input.actorUserId,input.commandId], maxRows: 1 });
      if (prior[0]) {
        if (prior[0].request_digest !== requestDigest) throw new RegistrationAccessError("idempotency_mismatch", 409);
        if (prior[0].state === "aborted") throw new RegistrationAccessError("registration_launch_aborted", 409);
        return prior[0];
      }
      const rows = await tx.query({ name: "registration_launch_configuration_v1", text: `SELECT display_name,configuration_json
        FROM data.space_agent_registrations WHERE ${REGISTRATION_KEY_SQL} FOR UPDATE`,
      values: registrationKeyValues(key), maxRows: 1 });
      if (!rows[0]) throw new RegistrationAccessError("registration_not_found", 404);
      const configuration = parseSpaceAgentConfiguration(rows[0].configuration_json);
      // A `repo:` workspace is the repository to work in, not a registered
      // directory; GitHub decides whether it can be cloned.
      if (input.workspaceReference !== undefined && !registrationRepository(input.workspaceReference) &&
          !configuration.workspaceReferences.includes(input.workspaceReference)) {
        throw new RegistrationAccessError("registration_workspace_not_configured", 403);
      }
      const resources = parseRegistrationResourceLimits({
        workspaces: input.workspaceReference === undefined ? [] : [input.workspaceReference], models: requirements.model ? [input.modelResource ?? requirements.model] : [],
        capabilities: requirements.requiredCapabilities });
      const decision = await requireRegistrationAdmission(tx, { key, actorUserId: input.actorUserId,
        channelId: input.channelId, requested: resources });
      const authorizationDigest = await digestCanonicalCloneCborV1({ key, actorUserId: input.actorUserId,
        channelId: input.channelId, sourceMessageId: input.sourceMessageId ?? null, selectionIndex: input.selectionIndex,
        sourceRevision: source?.sourceRevision ?? null, sourceBodyHash: bodyHash, resources, fence: decision.fence });
      const identities = ["run","instance","launch","execution","control"].map(kind => `${kind}:${crypto.randomUUID()}`);
      // A caller that reserved its key passes the ids; otherwise this staging
      // command reserves one. A background About session has no Channel
      // Instance, so its Run id stands in the binding's Instance slot.
      if (input.runId === undefined) {
        const reserved = await reserveNaturalKey(tx, { creationKey: `registration-launch:${input.actorUserId}:${input.commandId}`,
          channelId: input.channelId, scope: input.aboutSession ? "about" : "instance", at: new Date().toISOString() });
        identities[0] = reserved.runId;
        identities[1] = reserved.instanceId ?? reserved.runId;
      } else {
        identities[0] = text(input.runId, 200);
        if (input.instanceId !== undefined) identities[1] = text(input.instanceId, 200);
        if (input.aboutSession) identities[1] = identities[0];
      }
      const { body: _body, ...persistedRequest } = input;
      const created = await tx.query({ name: "registration_launch_stage_v2", text: `INSERT INTO data.registration_launch_intents
        (actor_user_id,command_id,request_digest,space_id,owner_user_id,machine_id,harness,channel_id,source_message_id,
         selection_index,source_body_hash,source_revision,run_id,instance_id,launch_id,execution_key,control_id,
         authorization_digest,grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,
         resources_json,configuration_json,display_name,state,launch_request_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,$25,'preparing',$26::jsonb) RETURNING *`,
      values: [input.actorUserId,input.commandId,requestDigest,...registrationKeyValues(key),input.channelId,input.sourceMessageId ?? null,
        input.selectionIndex,bodyHash,source?.sourceRevision ?? null,...identities,authorizationDigest,
        decision.fence.grantRevision,decision.fence.grantExecutionRevision,decision.fence.policyRevision,decision.fence.policyExecutionRevision,
        JSON.stringify(resources),JSON.stringify(configuration),rows[0].display_name,JSON.stringify(persistedRequest)], maxRows: 1 });
      return created[0]!;
    });
    if (intent.state === "committed") return this.result(intent, true);
    // This call is outside the Space transaction, including when the directory
    // and Space happen to share a serialized request session.
    const capacity = new PostgresRegistrationExecutionRepository(this.directory);
    let allocation: Awaited<ReturnType<PostgresRegistrationExecutionRepository["reserve"]>> | undefined;
    try {
      allocation = await capacity.reserve({ requestId: input.commandId, key, runId: String(intent.run_id),
        sourceCommandId: input.commandId, actorUserId: input.actorUserId, authorizationDigest: String(intent.authorization_digest), requirements });
      const workspace = await this.workspace(input);
      const launch = await this.launchSettings(input, allocation.environmentVersion);
      // Workspace values are checked against the selected registered reference,
      // never resolved from a caller-supplied path or repository name.
      const source = await this.database.transaction({ requestId: input.commandId, operation: "registration.launch.workspace-constraints",
        placement: this.placement }, tx => this.source(tx, input));
      const tags = source ? selectionLaunchConditions(input.body, source.selections[input.selectionIndex]!).tags : {} as AutoLaunchTags;
      if (tags.pwd && tags.pwd !== workspace.canonical_cwd) {
        throw new RegistrationAccessError("registration_workspace_constraint_mismatch", 403);
      }
      return await this.commit(input, intent, allocation, workspace, launch);
    } catch (error) {
      // Driver/transport/COMMIT-unknown errors retain preparation for exact retry.
      // Only a definite domain rejection can abort, and only while no Run exists.
      if ((error instanceof RegistrationAccessError || error instanceof MessageAuthorityError) && error.status < 500) {
        const aborted = await this.database.transaction({ requestId: input.commandId, operation: "registration.launch.abort", placement: this.placement },
          tx => tx.query({ name: "registration_launch_abort_v1", text: `UPDATE data.registration_launch_intents p
            SET state='aborted',allocation_id=$3,updated_at=clock_timestamp() WHERE actor_user_id=$1 AND command_id=$2
              AND state='preparing' AND NOT EXISTS (SELECT 1 FROM data.runs r WHERE r.run_id=p.run_id) RETURNING run_id`,
          values: [input.actorUserId,input.commandId,allocation?.allocationId ?? null], maxRows: 1 }));
        if (aborted.length) await capacity.abortPreparation({ requestId: input.commandId, key, runId: String(intent.run_id),
          sourceCommandId: input.commandId, actorUserId: input.actorUserId });
      }
      throw error;
    }
  }

  private result(row: QueryResultRow, reused: boolean) {
    return { runId: String(row.run_id), instanceId: String(row.instance_id), launchId: String(row.launch_id),
      agentName: String(row.display_name), reused };
  }

  /** A machine tag may name the Machine instead of spelling its id; never its hostname. */
  private async machineKnownAs(ownerUserId: string, machineId: string, tag: string): Promise<boolean> {
    if (tag === machineId) return true;
    const rows = await this.directory.transaction({ requestId: `registration-machine-name:${machineId}`,
      operation: "registration.launch.machine-name" }, tx => tx.query({ name: "registration_launch_machine_name_v3",
      text: `SELECT name FROM data.machines WHERE owner_user_id=$1 AND machine_id=$2`,
      values: [ownerUserId, machineId], maxRows: 1 }));
    return machineTagSelects(tag, machineId, String(rows[0]?.name ?? ""));
  }

  /** Undefined when no message carries the invocation. */
  private async source(tx: DatabaseTransaction, input: LaunchRequest) {
    if (input.sourceMessageId === undefined) return undefined;
    const source = await readMessageInvocationSelections(tx, { deriveFromText: true, spaceId: input.key.spaceId, channelId: input.channelId,
      messageId: input.sourceMessageId, actorUserId: input.actorUserId, body: input.body });
    const selection = source?.selections[input.selectionIndex];
    if (!source || !selection || (selection.target.kind === "capability" ? selection.target.harness !== input.key.harness
      : selection.target.kind === "registration" ? selection.target.key.spaceId !== input.key.spaceId ||
        !sameAgentRegistration(selection.target.key, input.key) : false)) {
      throw new RegistrationAccessError("registration_invocation_target_mismatch", 403);
    }
    const options = selectionLaunchConditions(input.body, selection);
    const tags = options.tags;
    const machineOk = !tags.machine || await this.machineKnownAs(input.key.ownerUserId, input.key.machineId, tags.machine);
    if (options.error || (input.useRuntimeDefaultModel && (tags.model || tags.effort)) || (tags.repo && input.workspaceReference !== `repo:${repoSummonReference(tags.repo)}`) ||
        (tags.pwd && input.workspaceReference === undefined) ||
        (tags.machine && !machineOk) ||
        (tags.harness && canonicalRegistrationHarness(tags.harness) !== input.key.harness) ||
        (tags.model && tags.model !== input.requirements.model && tags.model !== input.modelResource) ||
        (tags.effort && tags.effort !== input.requirements.effort) ||
        !sameHarnessParameterValues(launchHarnessParameters(tags), input.requirements.parameters ?? {})) {
      throw new RegistrationAccessError("invalid_registration_launch", 400);
    }
    return source;
  }

  /** The environment revision admitted by the reservation is the one whose
   * launch settings start the Run; a later edit waits for the next launch. */
  private async launchSettings(input: LaunchRequest, environmentVersion: number) {
    return this.directory.transaction({ requestId: input.commandId, operation: "registration.launch.settings" }, async tx => {
      const rows = await tx.query({ name: "registration_launch_settings_v1", text: `SELECT declaration_json,version
        FROM control.agent_registration_environments WHERE owner_user_id=$1 AND machine_id=$2 AND harness=$3`,
      values: [input.key.ownerUserId,input.key.machineId,input.key.harness], maxRows: 1 });
      if (!rows[0] || Number(rows[0].version) !== environmentVersion) {
        throw new RegistrationAccessError("registration_environment_changed", 409);
      }
      const environment = parseAgentRegistrationEnvironment(rows[0].declaration_json);
      if (input.modelResource && (environment.modelAliases?.[input.modelResource] ?? input.modelResource) !== input.requirements.model) {
        throw new RegistrationAccessError("registration_model_unavailable", 409);
      }
      return environment.launch;
    });
  }

  // v3 daemons take launch settings from the Hub registration. A v2 daemon
  // still requires a local installation record, so it cannot be routed here.
  private async workspace(input: LaunchRequest) {
    const required = input.requiredHostCapabilities ?? [];
    return this.directory.transaction({ requestId: input.commandId, operation: "registration.launch.workspace" }, async tx => {
      const reference = input.workspaceReference;
      // A route that exists but cannot show the required host abilities is a
      // capability refusal, not a missing daemon.
      const refuse = async (code: string, query: () => Promise<readonly QueryResultRow[]>, key: Parameters<typeof registrationRouteRefusal>[2]) =>
        required.length && (await query()).length ? new RegistrationAccessError("registration_capability_unavailable", 409)
          : registrationRouteRefusal(tx, code, key);
      if (reference === undefined || reference.startsWith("repo:")) {
        const repo = reference?.slice(5);
        if (repo !== undefined && (!repo || repoSummonReference(repo) !== repo)) {
          throw new RegistrationAccessError("invalid_registration_repository", 400);
        }
        // A daemon runs a registered launch with no workspace reference only
        // once it declares the managed-directory capability.
        const repoRoutes = (capabilities: readonly string[]) => tx.query({ name: "registration_launch_repo_route_v5",
          text: `SELECT hostname FROM data.machine_daemons
          WHERE owner_user_id=$1 AND machine_id=$2 AND status='online' AND capabilities_json ? 'registration_launch_v3'
            AND ($3::text IS NULL OR capabilities_json ? $3)
            AND (NOT $4::boolean OR capabilities_json ? 'registration_optional_model_v1')
            AND (NOT $6::boolean OR capabilities_json ? 'machine_routing_parameters_v1')
            AND ${HOST_CAPABILITY_ROUTE_SQL("$5")} LIMIT 2 FOR SHARE`,
          values: [input.key.ownerUserId,input.key.machineId,reference === undefined ? "registration_managed_v1" : null,
            input.useRuntimeDefaultModel === true, capabilities, Object.keys(input.requirements.parameters ?? {}).length > 0], maxRows: 2 });
        const routes = await repoRoutes(required);
        const unrouted = reference === undefined ? "registration_managed_route_unavailable" : "registration_repo_route_unavailable";
        if (!routes.length) throw await refuse(unrouted, () => repoRoutes([]), input.key);
        if (routes.length !== 1) throw new RegistrationAccessError(unrouted, 409);
        const managedKey = `registration-${(await digestCanonicalCloneCborV1([input.key,input.commandId])).slice(0,48)}`;
        // `syntheticManagementWorkspace` marks a Channel About session; the
        // generic flag marks an unregistered cwd. Released daemons pre-sync a
        // whole-Space mirror unless the projection kind is "channel" (read on demand).
        const flags = input.aboutSession && !repo
          ? { syntheticManagementWorkspace: true, managementProjectionKind: "channel" }
          : { syntheticManagedWorkspace: true };
        return { hostname: routes[0]!.hostname, canonical_cwd: `.xmatrix-management/${managedKey}`, managed_key: managedKey,
          ...(repo ? { remote_repo: repo } : {}), metadata_json: { displayName: repo ?? "xMatrix", managedWorkspaceKey: managedKey,
            ...flags, ...(repo ? { remoteRepo: repo } : {}) } };
      }
      const workspaceRoutes = (capabilities: readonly string[]) => tx.query({ name: "registration_launch_workspace_v4",
        text: `SELECT w.canonical_cwd,w.metadata_json,d.hostname
        FROM data.workspaces w JOIN data.machine_daemons d ON d.owner_user_id=w.owner_user_id AND d.machine_id=w.machine_id
        WHERE w.workspace_id=$1 AND w.owner_user_id=$2 AND w.machine_id=$3 AND d.status='online'
          AND d.capabilities_json ? 'registration_launch_v3'
          AND (NOT $4::boolean OR d.capabilities_json ? 'registration_optional_model_v1')
          AND (NOT $6::boolean OR d.capabilities_json ? 'machine_routing_parameters_v1')
          AND ${HOST_CAPABILITY_ROUTE_SQL("$5", "d.")} LIMIT 1 FOR SHARE OF w,d`,
        values: [input.workspaceReference,input.key.ownerUserId,input.key.machineId,input.useRuntimeDefaultModel === true,
          capabilities, Object.keys(input.requirements.parameters ?? {}).length > 0], maxRows: 1 });
      const rows = await workspaceRoutes(required);
      if (!rows[0]) throw await refuse("registration_workspace_or_daemon_unavailable", () => workspaceRoutes([]),
        { ...input.key, workspaceId: reference });
      return rows[0];
    });
  }

  private async commit(input: LaunchRequest, staged: QueryResultRow,
    allocation: { allocationId: string; environmentVersion: number; runtimeModel?: string }, workspace: QueryResultRow,
    launch: AgentRegistrationLaunch | undefined) {
    return this.database.transaction({ requestId: input.commandId, operation: "registration.launch.commit", placement: this.placement }, async tx => {
      const source = await this.source(tx, input);
      const rows = await tx.query({ name: "registration_launch_commit_lock_v1", text: `SELECT * FROM data.registration_launch_intents
        WHERE actor_user_id=$1 AND command_id=$2 FOR UPDATE`, values: [input.actorUserId,input.commandId], maxRows: 1 });
      const row = rows[0];
      if (!row || row.run_id !== staged.run_id || row.request_digest !== staged.request_digest || row.state === "aborted" ||
        (source && (Number(row.source_revision) !== source.sourceRevision || row.source_body_hash !== source.sourceBodyHash))) {
        throw new RegistrationAccessError("registration_launch_changed", 409);
      }
      if (row.state === "committed") return this.result(row, true);
      const resources = parseRegistrationResourceLimits(row.resources_json);
      await requireRegistrationAdmission(tx, { key: input.key, actorUserId: input.actorUserId, channelId: input.channelId,
        requested: resources, fence: { key: input.key, grantRevision: Number(row.grant_revision), grantExecutionRevision: Number(row.grant_execution_revision),
          policyRevision: Number(row.policy_revision), policyExecutionRevision: Number(row.policy_execution_revision) } });
      await tx.query({ name: "registration_launch_channel_lock_v1", text: `SELECT pg_advisory_xact_lock(hashtextextended('runtime-instance:'||$1,0))`,
      values: [input.channelId], maxRows: 1 });
      if (input.aboutSession && (await this.aboutKeeper(tx, input.channelId, false, String(row.run_id))).keeper) {
        throw new RegistrationAccessError("about_session_active", 409);
      }
      // A natural Instance id carries its ordinal; the counter skips the
      // historical >=8e15 addresses, which are not a spawn counter.
      const ordinal = input.aboutSession ? undefined : await instanceOrdinalFor(tx, input.channelId, String(row.instance_id));
      const binding: RegistrationLaunchBinding = { schemaVersion: 1, key: input.key, runId: String(row.run_id), instanceId: String(row.instance_id),
        allocationId: allocation.allocationId, authorizationDigest: String(row.authorization_digest), environmentVersion: allocation.environmentVersion,
        runtimeModel: allocation.runtimeModel, resources };
      const at = new Date().toISOString(), configuration = parseSpaceAgentConfiguration(row.configuration_json);
      const initialMessageId = input.sourceMessageId ?? input.initialMessageId;
      const messageSource = initialMessageId === undefined ? undefined : await initialMessageSource(tx, {
        spaceId: input.key.spaceId, channelId: input.channelId, messageId: initialMessageId, actorUserId: input.actorUserId });
      if (input.sourceMessageId !== undefined && (!messageSource || messageSource.bodyHash !== row.source_body_hash)) {
        throw new RegistrationAccessError("registration_source_changed", 409);
      }
      // The daemon's durable harness-session map and Runtime recovery must use
      // the same key. A registration identity alone does not identify a session.
      const resumeSessionKey = `resume:${input.key.ownerUserId}:${input.channelId}:${row.instance_id}`;
      const spaceRules = await spaceRulesSpawnFields(tx, input.key.spaceId);
      const payload = withInitialMessageSource({ type: "machine_spawn_agent", requestId: row.control_id, spaceId: input.key.spaceId,
        channelId: input.channelId, runId: row.run_id, instanceId: row.instance_id, launchId: row.launch_id,
        executionKey: row.execution_key, registration: registrationLaunchBindingForDaemon(binding), identityId: row.instance_id, resumeSessionKey,
        ...registrationLaunchSpawnFields(launch, input.key.harness),
        agentName: row.display_name, prompt: input.body,
        // The daemon places a non-repository managed directory by this key; an
        // About session's overlay and `--space` need the real Space id.
        ...(workspace.managed_key && !workspace.remote_repo
          ? { managementSpaceId: input.aboutSession ? input.key.spaceId : workspace.managed_key } : {}),
        ...(initialMessageId !== undefined ? { sourceMessageId: initialMessageId } : {}),
        context: { ...(!input.useRuntimeDefaultModel ? { requestedModel: allocation.runtimeModel } : {}),
          ...(input.requirements.effort ? { requestedEffort: input.requirements.effort } : {}),
          ...(input.requirements.parameters ? { requestedParameters: input.requirements.parameters } : {}) },
        ...registrationInstructionsSpawnFields(configuration), ...spaceRules,
        ...(workspace.remote_repo ? { remoteRepo: workspace.remote_repo, runWorktree: true } : {}),
        workspace: { ...(workspace.managed_key ? { managedKey: workspace.managed_key, metadata: workspace.metadata_json } : {}), ownerUserId: input.key.ownerUserId, machineId: input.key.machineId, hostId: workspace.hostname ?? "", hostname: workspace.hostname ?? undefined,
          canonicalCwd: workspace.canonical_cwd, displayName: String(workspace.metadata_json?.displayName ?? "Workspace"),
          visibility: "private", createdAt: at, updatedAt: at, lastSeenAt: at } }, messageSource);
      const session = input.aboutSession ? { runtimeSessionId: String(row.instance_id), channelWriteAllowed: false,
        channelAboutTriggerRequestId: input.aboutSession.triggerRequestId,
        channelAboutTriggerMessageId: input.aboutSession.triggerMessageId ?? null,
        channelAboutPendingMessageId: input.aboutSession.triggerMessageId ?? null,
        channelAboutPendingRequestId: input.aboutSession.triggerRequestId, channelAboutPendingActorUserId: input.actorUserId,
        ...(input.aboutSession.successorOfRunId ? { channelAboutSuccessorOfRunId: input.aboutSession.successorOfRunId } : {}) } : {};
      // The spawn command's id is how a delete of a still-starting Instance waits
      // for that exact spawn before abandoning it.
      const metadata = { ...input.runMetadata, ...session, machineId: input.key.machineId, hostId: workspace.hostname ?? "", hostname: workspace.hostname ?? undefined, executionKey: row.execution_key, resumeSessionKey,
        spawnControlId: row.control_id,
        ...(workspace.managed_key ? { managedWorkspaceKey: workspace.managed_key } : {}),
        ...(initialMessageId !== undefined ? { sourceMessageId: initialMessageId } : {}),
        summonedByUserId: input.actorUserId, identityKind: "instance",
        requestedRuntimeModel: allocation.runtimeModel ?? null, modelResource: resources.models[0] ?? null,
        agentName: row.display_name, useRuntimeDefaultModel: input.useRuntimeDefaultModel === true,
        ...(workspace.remote_repo ? { remoteRepo: workspace.remote_repo, runWorktree: true } : {}),
        ...(input.parameterEvidence ? { routingDecision: { source: "jev", parameters: input.parameterEvidence, rows: [],
          machine: boundMachine(input.key.machineId, input.machineName) } } : {}) };
      await tx.query({ name: "registration_launch_run_v1", text: `INSERT INTO data.runs
        (run_id,owner_user_id,channel_id,workspace_machine_id,workspace_canonical_cwd,
         status,version,metadata_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'starting',1,$6::jsonb,$7,$7)`,
      values: [row.run_id,input.key.ownerUserId,input.channelId,input.key.machineId,workspace.canonical_cwd,JSON.stringify(hostnameMetadata(metadata)),at], maxRows: 0 });
      await tx.query({ name: "registration_launch_run_binding_v1", text: `INSERT INTO data.run_agent_registrations
        (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
         grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      values: [row.run_id,...registrationKeyValues(input.key),input.actorUserId,allocation.allocationId,row.authorization_digest,
        row.grant_revision,row.grant_execution_revision,row.policy_revision,row.policy_execution_revision,JSON.stringify(resources)], maxRows: 0 });
      if (!input.aboutSession) await tx.query({ name: "registration_launch_instance_v1", text: `INSERT INTO data.instances
        (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'offline',1,$5,$5)`, values: [row.instance_id,row.run_id,input.channelId,ordinal,at], maxRows: 0 });
      await tx.query({ name: "registration_launch_delivery_v1", text: `INSERT INTO data.agent_launches
        (launch_id,space_id,channel_id,trigger_id,launch_kind,owner_user_id,run_id,instance_id,
         execution_key,control_id,machine_id,hostname,state,spawn_payload_json,next_attempt_at,created_at,updated_at,prepared_at)
        VALUES ($1,$2,$3,$4,'registration',$5,$6,$7,$8,$9,$10,$11,'prepared',$12::jsonb,$13,$13,$13,$13)`,
      values: [row.launch_id,input.key.spaceId,input.channelId,input.sourceMessageId ?? input.presentationMessageId ?? input.commandId,input.key.ownerUserId,row.run_id,row.instance_id,
        row.execution_key,row.control_id,input.key.machineId,workspace.hostname,JSON.stringify(payload),at], maxRows: 0 });
      await tx.query({ name: "registration_launch_committed_v1", text: `UPDATE data.registration_launch_intents SET
        state='committed',updated_at=clock_timestamp() WHERE actor_user_id=$1 AND command_id=$2`, values: [input.actorUserId,input.commandId], maxRows: 0 });
      await commitRuntime(tx, input.key.spaceId, { commandId: input.commandId, kind: "registration_launch", entityId: row.run_id,
        runId: row.run_id, instanceId: row.instance_id, launchId: row.launch_id, status: "starting" }, at);
      return this.result(row, false);
    });
  }

  /** Recover before any new decision or configuration lookup. Source and authority
   * are rechecked by prepare; the committed request remains immutable. */
  async recoverFromMessage(input: {
    commandId: string; actorUserId: string; channelId: string; sourceMessageId: string;
    selectionIndex: number; body: string;
  }) {
    const rows = await this.database.transaction({ requestId: input.commandId,
      operation: "registration.launch.recover", placement: this.placement }, async tx => {
      const source = await readMessageInvocationSelections(tx, { deriveFromText: true, spaceId: this.placement.spaceId,
        channelId: input.channelId, messageId: input.sourceMessageId, actorUserId: input.actorUserId, body: input.body });
      if (!source?.selections[input.selectionIndex]) throw new RegistrationAccessError("registration_invocation_target_mismatch", 403);
      const rows = await tx.query({ name: "registration_launch_recover_v1", text: `SELECT launch_request_json,source_body_hash,
        source_revision,channel_id,source_message_id,selection_index,state FROM data.registration_launch_intents
        WHERE actor_user_id=$1 AND command_id=$2`, values: [input.actorUserId,input.commandId], maxRows: 1 });
      if (rows[0] && Number(rows[0].source_revision) !== source.sourceRevision) {
        throw new RegistrationAccessError("registration_source_changed", 409);
      }
      return rows;
    });
    if (!rows[0]) return undefined;
    const row = rows[0];
    if (row.channel_id !== input.channelId || row.source_message_id !== input.sourceMessageId ||
        Number(row.selection_index) !== input.selectionIndex || row.source_body_hash !== await digestCanonicalCloneCborV1(input.body)) {
      throw new RegistrationAccessError("idempotency_mismatch", 409);
    }
    if (row.state === "aborted") throw new RegistrationAccessError("registration_launch_aborted", 409);
    if (!row.launch_request_json || typeof row.launch_request_json !== "object" || Array.isArray(row.launch_request_json)) {
      throw new RegistrationAccessError("registration_launch_recovery_unavailable", 409);
    }
    return this.prepare({ ...row.launch_request_json, ...input });
  }

  /** Consume stored invocation intent. Capability selections pick among currently
   * authorized locations; explicit registration selections keep their tuple. */
  async dispatchFromMessage(input: {
    commandId: string; actorUserId: string; channelId: string; sourceMessageId: string; body: string;
    /** The author's "launch anyway" for one mention Jev read as a non-request:
     * only that summon is prepared, as if it carried `launch:force`. */
    forceMention?: string;
  }, choose?: RegistrationLaunchChooser) {
    const actorUserId = text(input.actorUserId), channelId = text(input.channelId),
      sourceMessageId = text(input.sourceMessageId), commandId = text(input.commandId, 200);
    const source = await this.database.transaction({ requestId: commandId,
      operation: "registration.launch.read-source", placement: this.placement }, async tx => {
      return readMessageInvocationSelections(tx, { deriveFromText: true, spaceId: this.placement.spaceId, channelId,
        messageId: sourceMessageId, actorUserId, body: input.body });
    });
    if (!source?.selections.length) {
      return { selectionCount: 0, prepared: [], rejected: [] };
    }
    const prepared: Array<{ runId: string; instanceId: string; launchId: string; reused: boolean }> = [];
    const rejected: Array<{ selectionIndex: number; code: string; sourceMention: string }> = [];
    // The summon as written, address through its last condition: the text the
    // web parses from the message and binds this launch or refusal to.
    const summonText = (selection: { start: number; end: number; text: string }) =>
      input.body.slice(selection.start, selectionLaunchConditions(input.body, selection).end);
    for (const [selectionIndex, selection] of source.selections.entries()) {
      if (input.forceMention !== undefined && summonText(selection) !== input.forceMention) continue;
      try {
        const recovered = await this.recoverFromMessage({ ...input, commandId: `${commandId}:${selectionIndex}`, selectionIndex });
        if (recovered) { prepared.push(recovered); continue; }
        const options = selectionLaunchConditions(input.body, selection);
        if (options.error) throw new RegistrationAccessError("invalid_registration_launch", 400);
        // Read alongside the candidates: the repository list comes from GitHub.
        const repositoryCatalog = summonRepositoryCatalog(this.repositoryReader, actorUserId, options.tags.repo);
        const listed = await this.candidatesFor(selection.target.kind === "registration"
          ? parseSpaceAgentRegistrationKey(selection.target.key)
          : selection.target.kind === "capability" ? { harness: selection.target.harness }
          // `@auto` reaches every registration its conditions allow.
          : { ...(options.tags.harness ? { harness: canonicalRegistrationHarness(options.tags.harness) } : {}),
            ...(options.tags.machine?.startsWith("machine:") ? { machineId: options.tags.machine } : {}) }, repositoryCatalog);
        const candidates = listed.offered;
        if (!candidates.length) {
          const code = listed.offlineOnly ? "registration_daemon_offline"
            : launchRefusalCode("registration_not_found", options.tags.machine, listed.blocked);
          throw new RegistrationAccessError(code, code === "registration_daemon_offline" ? 409 : 404);
        }
        if (!choose) {
          rejected.push({ selectionIndex, code: "registration_selection_unconfigured", sourceMention: summonText(selection) });
          continue;
        }
        let selected: Awaited<ReturnType<RegistrationLaunchChooser>>;
        try {
          selected = await choose({ message: input.body, sourceSequence: source.sourceSequence, candidates,
            blocked: listed.blocked,
            tags: input.forceMention !== undefined ? { ...options.tags, launch: "force" } : options.tags,
            summon: { text: summonText(selection), start: selection.start, end: options.end, authorKind: source.authorKind } });
        }
        catch (error) {
          // A model or its input read failed before any launch allocation. Do not
          // store provider text or substitute a server-selected configuration.
          const code = error instanceof RegistrationAccessError &&
            REGISTRATION_PREPARATION_REJECTION_CODES.includes(error.code)
            ? error.code : "registration_selection_failed";
          rejected.push({ selectionIndex, code, sourceMention: summonText(selection) });
          continue;
        }
        const candidate = candidates.find(item => sameAgentRegistration(item.key, selected.key) && item.key.spaceId === selected.key.spaceId);
        if (!candidate || !selectedModelGranted(candidate, selected) || selected.workspaceReference === undefined ||
            !candidate.workspaceReferences.includes(selected.workspaceReference)) {
          throw new RegistrationAccessError("registration_selection_invalid", 409);
        }
        validateSelectedHarnessParameters(candidate, selected, options.tags);
        prepared.push(await this.prepare({ commandId: `${commandId}:${selectionIndex}`, actorUserId, channelId,
          sourceMessageId, selectionIndex, body: input.body, key: candidate.key, workspaceReference: selected.workspaceReference,
          // The web binds a launch's status, steps and Jev decision to the summon it answers.
          runMetadata: { sourceMention: summonText(selection) },
          ...(candidate.machineName ? { machineName: candidate.machineName } : {}),
          ...selectedParameters(selected, candidate.key.harness) }));
      } catch (error) {
        if ((error instanceof RegistrationAccessError || error instanceof MessageAuthorityError) && error.status < 500) {
          rejected.push({ selectionIndex, code: error.code, sourceMention: summonText(selection) });
          continue;
        }
        throw error;
      }
    }
    return { selectionCount: source.selections.length, prepared, rejected };
  }

  /** Any launch input: Jev chooses among every authorized registration in the
   * Space. No message is required, and a private managed directory is offered
   * when the input needs no repository. */
  async dispatchInput(input: {
    /** The predecessor's stable Agent registration cannot receive its own work. */
    excludeSourceInstanceId?: string;
    commandId: string; actorUserId: string; channelId: string; body: string; runMetadata?: Record<string, unknown>;
    runId?: string; instanceId?: string;
    initialMessageId?: string; presentationMessageId?: string; aboutSession?: RegistrationAboutSession;
    /** Constraints the caller's own text states. */
    tags?: AutoLaunchTags;
    /** Capabilities the work needs; those a daemon can prove gate where it runs. */
    requiredCapabilities?: readonly string[];
  }, choose: RegistrationLaunchChooser) {
    if (Object.hasOwn(input, "oneshot") || Object.keys(input.tags ?? {}).some(key =>
        !AUTO_LAUNCH_FIELDS.includes(key as typeof AUTO_LAUNCH_FIELDS[number]))) {
      throw new RegistrationAccessError("invalid_registration_launch", 400);
    }
    const actorUserId = text(input.actorUserId), channelId = text(input.channelId), commandId = text(input.commandId, 200);
    if (typeof input.body !== "string" || !input.body.trim()) throw new RegistrationAccessError("invalid_registration_launch", 400);
    const excludeSourceInstanceId = input.excludeSourceInstanceId;
    const excluded = excludeSourceInstanceId === undefined ? undefined
      : await this.database.transaction({ requestId: commandId, operation: "registration.launch.exclude-source",
        placement: this.placement }, async tx => {
        const row = (await tx.query({ name: "registration_launch_excluded_source_v1", text: `SELECT
          b.space_id,b.owner_user_id,b.machine_id,b.harness
          FROM data.instances i JOIN data.run_agent_registrations b ON b.run_id=i.run_id
          WHERE i.instance_id=$1 AND i.channel_id=$2 AND b.space_id=$3 AND b.owner_user_id=$4`,
        values: [text(excludeSourceInstanceId), channelId, this.placement.spaceId, actorUserId], maxRows: 1 }))[0];
        if (!row) throw new RegistrationAccessError("instance_not_found", 404);
        return parseSpaceAgentRegistrationKey({ spaceId: row.space_id, ownerUserId: row.owner_user_id,
          machineId: row.machine_id, harness: row.harness });
      });
    const prior = await this.database.transaction({ requestId: commandId, operation: "registration.launch.input-read",
      placement: this.placement }, async tx => {
      return tx.query({ name: "registration_launch_input_existing_v1", text: `SELECT launch_request_json,state
        FROM data.registration_launch_intents WHERE actor_user_id=$1 AND command_id=$2`,
      values: [actorUserId,commandId], maxRows: 1 });
    });
    if (prior[0]) {
      if (prior[0].state === "aborted") throw new RegistrationAccessError("registration_launch_aborted", 409);
      const request = prior[0].launch_request_json;
      if (!request || typeof request !== "object" || Array.isArray(request) || request.sourceMessageId !== undefined) {
        throw new RegistrationAccessError("registration_launch_recovery_unavailable", 409);
      }
      if (excluded && sameAgentRegistration(parseSpaceAgentRegistrationKey(request.key), excluded)) {
        throw new RegistrationAccessError("handoff_same_agent", 409);
      }
      return this.withHost(commandId, await this.prepare({ ...request, body: input.body }));
    }
    let retiredAboutSessions: ChannelAboutSessionStopTarget[] = [];
    if (input.aboutSession) {
      const serving = await this.servingAboutSession(commandId, channelId, actorUserId, input.aboutSession);
      retiredAboutSessions = serving.retired;
      if (serving.keeper) return withRetiredAboutSessions(serving.keeper, retiredAboutSessions);
    }
    // Read alongside the candidates: the repository list comes from GitHub.
    const repositoryCatalog = input.aboutSession ? undefined
      : summonRepositoryCatalog(this.repositoryReader, actorUserId, input.tags?.repo);
    const requiredHostCapabilities = hostObservedRequirements(input.requiredCapabilities ?? []);
    const listed = await this.candidatesFor({ managedWorkspace: true, requiredHostCapabilities }, repositoryCatalog);
    const authorized = listed.offered
      .filter(candidate => !excluded || !sameAgentRegistration(candidate.key, excluded));
    // An About session works in its private directory, never a repository.
    const candidates = input.aboutSession
      ? authorized.map(candidate => ({ ...candidate, workspaces: [] })) : authorized;
    if (!candidates.length) {
      // Say which requirement left nothing, rather than that nothing exists.
      if (requiredHostCapabilities.length && (await this.candidatesFor({ managedWorkspace: true }, repositoryCatalog)).offered.length) {
        throw new RegistrationAccessError("registration_capability_unavailable", 409);
      }
      const code = listed.offlineOnly ? "registration_daemon_offline"
        : launchRefusalCode("registration_not_found", input.tags?.machine, listed.blocked);
      throw new RegistrationAccessError(code, code === "registration_daemon_offline" ? 409 : 404);
    }
    // An About session works in its private directory, so it takes no location;
    // any other caller may constrain the directory or repository it states.
    if (input.aboutSession && (input.tags?.repo || input.tags?.pwd)) {
      throw new RegistrationAccessError("invalid_registration_launch", 400);
    }
    const tags: AutoLaunchTags = { ...input.tags };
    const selected = await choose({ message: input.body, tags, candidates, blocked: listed.blocked, managedWorkspace: true });
    const candidate = candidates.find(item => sameAgentRegistration(item.key, selected.key) && item.key.spaceId === selected.key.spaceId);
    if (!candidate || !selectedModelGranted(candidate, selected) || (selected.workspaceReference !== undefined &&
        (input.aboutSession || !candidate.workspaceReferences.includes(selected.workspaceReference))) ||
        (input.tags?.pwd || input.tags?.repo) && selected.workspaceReference === undefined) {
      throw new RegistrationAccessError("registration_selection_invalid", 409);
    }
    validateSelectedHarnessParameters(candidate, selected, tags);
    const request = { commandId, actorUserId, channelId, selectionIndex: 0, body: input.body, key: candidate.key,
      ...(selected.workspaceReference !== undefined ? { workspaceReference: selected.workspaceReference } : {}),
      ...(requiredHostCapabilities.length ? { requiredHostCapabilities } : {}),
      ...(input.runMetadata ? { runMetadata: input.runMetadata } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
      ...(input.aboutSession ? { aboutSession: input.aboutSession } : {}),
      ...(input.initialMessageId !== undefined ? { initialMessageId: text(input.initialMessageId) } : {}),
      ...(input.presentationMessageId !== undefined ? { presentationMessageId: text(input.presentationMessageId) } : {}),
      ...(candidate.machineName ? { machineName: candidate.machineName } : {}),
      ...selectedParameters(selected, candidate.key.harness) };
    try { return withRetiredAboutSessions(await this.withHost(commandId, await this.prepare(request)), retiredAboutSessions); }
    catch (error) {
      // A concurrent launch won the Channel while this one was being chosen.
      if (!(error instanceof RegistrationAccessError)) throw error;
      const keeper = error.code === "about_session_active" && input.aboutSession
        ? (await this.servingAboutSession(commandId, channelId, actorUserId, input.aboutSession)).keeper : undefined;
      if (!keeper) throw error;
      return withRetiredAboutSessions(keeper, retiredAboutSessions);
    }
  }

  /** A message that summons nobody: the harness Jev reads its author wants
   * started, or Jev's `start_intent_declined`. Nothing is prepared here; the
   * caller summons that harness with an ordinary `@<harness>` message. */
  async readHarnessToStart(input: { actorUserId: string; body: string; onHarness?: (harness: string) => Promise<void> },
    choose: RegistrationLaunchChooser): Promise<string> {
    const repositoryCatalog = summonRepositoryCatalog(this.repositoryReader, text(input.actorUserId), undefined);
    const listed = await this.candidatesFor({ managedWorkspace: true }, repositoryCatalog);
    const candidates = listed.offered;
    if (!candidates.length) throw new RegistrationAccessError("registration_not_found", 404);
    const selected = await choose({ message: input.body, tags: {}, candidates, managedWorkspace: true, askToStart: true,
      ...(input.onHarness ? { onHarness: input.onHarness } : {}) });
    return selected.key.harness;
  }

  /** The About session already serving this Channel; a new trigger is recorded
   * as its pending request. A successor must follow its exact terminal predecessor. */
  private async servingAboutSession(commandId: string, channelId: string, actorUserId: string, about: RegistrationAboutSession) {
    const serving = await this.database.transaction({ requestId: commandId, operation: "registration.launch.about-session",
      placement: this.placement }, async tx => {
      if (about.triggerMessageId) {
        const trigger = await tx.query({ name: "registration_about_trigger_message_v1",
          text: "SELECT message_id FROM data.messages WHERE space_id=$1 AND channel_id=$2 AND message_id=$3",
          values: [this.placement.spaceId,channelId,about.triggerMessageId], maxRows: 1 });
        if (!trigger[0]) throw new RegistrationAccessError("channel_about_input_mismatch", 403);
      }
      await tx.query({ name: "registration_launch_channel_lock_v1", text: `SELECT pg_advisory_xact_lock(hashtextextended('runtime-instance:'||$1,0))`,
        values: [channelId], maxRows: 1 });
      if (about.successorOfRunId) {
        const predecessor = (await tx.query({ name: "registration_launch_about_predecessor_v1",
          text: "SELECT channel_id,status,metadata_json FROM data.runs WHERE run_id=$1", values: [about.successorOfRunId], maxRows: 1 }))[0];
        const body = predecessor?.metadata_json ?? {};
        if (!predecessor || predecessor.channel_id !== channelId ||
            !isTerminalRunStatus(predecessor.status) ||
            body.routedAs !== "management_channel_about" || body.channelAboutPendingRequestId !== about.triggerRequestId) {
          throw new RegistrationAccessError("about_successor_mismatch", 409);
        }
      }
      const { keeper, retired } = await this.aboutKeeper(tx, channelId, true);
      if (!keeper) return { retired };
      const body = keeper.metadata_json ?? {};
      const original = typeof body.channelAboutTriggerRequestId === "string" ? body.channelAboutTriggerRequestId : undefined;
      const pending = typeof body.channelAboutPendingRequestId === "string" ? body.channelAboutPendingRequestId : original;
      if (!about.successorOfRunId && about.triggerRequestId !== original && about.triggerRequestId !== pending) {
        await tx.query({ name: "registration_launch_about_pending_v1", text: `UPDATE data.runs SET metadata_json=$1::jsonb,
          version=version+1,updated_at=clock_timestamp() WHERE run_id=$2 AND version=$3`,
        values: [JSON.stringify({ ...body, channelAboutPendingRequestId: about.triggerRequestId,
          channelAboutPendingMessageId: about.triggerMessageId ?? null,
          channelAboutPendingActorUserId: actorUserId }), keeper.run_id, keeper.run_version], maxRows: 0 });
      }
      return { keeper, retired };
    });
    const { keeper, retired } = serving;
    return {
      keeper: keeper ? { runId: String(keeper.run_id), instanceId: String(keeper.metadata_json?.runtimeSessionId ?? ""), launchId: "",
        agentName: String(keeper.metadata_json?.agentName ?? "Agent"), hostId: String(keeper.metadata_json?.hostname ?? keeper.metadata_json?.hostId ?? ""),
        reused: true, coalesced: true } : undefined,
      retired,
    };
  }

  /** Caller holds the Channel's runtime-instance lock. */
  private async aboutKeeper(tx: DatabaseTransaction, channelId: string,
    fence: boolean, exceptRunId?: string) {
    const candidates = await tx.query({ name: "registration_launch_about_candidates_v2",
      text: `SELECT r.run_id,r.channel_id,r.status AS run_status,r.version AS run_version,r.metadata_json,
        (SELECT i.instance_id FROM data.instances i WHERE i.run_id=r.run_id LIMIT 1) AS instance_id,
        (SELECT b.owner_user_id FROM data.run_agent_registrations b WHERE b.run_id=r.run_id LIMIT 1) AS machine_owner_user_id
        FROM data.runs r WHERE r.channel_id=$1 AND r.status IN (${ACTIVE_RUN_STATUS_SQL})
          AND r.metadata_json->>'routedAs'='management_channel_about' AND r.run_id IS DISTINCT FROM $2
        ORDER BY r.created_at DESC,r.run_id LIMIT 51 FOR UPDATE OF r`,
    values: [channelId, exceptRunId ?? null], maxRows: 51 });
    if (candidates.length > 50) throw new RegistrationAccessError("about_session_limit", 409);
    // A session that finished its one turn never reads another trigger, so it
    // is not kept. Its process still runs; the daemon ends it (see `retired`),
    // since a reported phase never terminalizes a Run by itself.
    const done = (candidate: QueryResultRow) =>
      ABOUT_SESSION_DONE_PHASES.has(String(candidate.metadata_json?.invocationProgress?.phase ?? ""));
    const keeper = candidates.find(candidate => !candidate.instance_id && !done(candidate));
    const retired = candidates.filter(done).map(aboutSessionStopTarget)
      .filter((target): target is ChannelAboutSessionStopTarget => Boolean(target));
    if (!fence) return { keeper, retired };
    const at = new Date().toISOString();
    for (const candidate of candidates) {
      if (candidate.run_id === keeper?.run_id || done(candidate)) continue;
      await tx.query({ name: "registration_launch_about_run_fence_v1", text: `UPDATE data.runs
        SET status='stopped',version=version+1,updated_at=$1,finished_at=$1
        WHERE run_id=$2 AND version=$3 AND status IN (${ACTIVE_RUN_STATUS_SQL})`,
      values: [at, candidate.run_id, candidate.run_version], maxRows: 0 });
    }
    return { keeper, retired };
  }

  private async withHost<T extends { launchId: string }>(commandId: string, launch: T): Promise<T & { hostId: string }> {
    const rows = await this.database.transaction({ requestId: commandId, operation: "registration.launch.host",
      placement: this.placement }, tx => tx.query({ name: "registration_launch_host_v1",
      text: `SELECT hostname FROM data.agent_launches WHERE launch_id=$1`, values: [launch.launchId], maxRows: 1 }));
    return { ...launch, hostId: String(rows[0]?.hostname ?? "") };
  }

  private async candidatesFor(target: { harness?: string; ownerUserId?: string; machineId?: string; managedWorkspace?: boolean;
    requiredHostCapabilities?: readonly string[] }, catalog?: Promise<RegistrationRepositoryCatalog | undefined>): Promise<{
      offered: RegistrationLaunchCandidate[]; blocked: LaunchMachineBlock[];
      /** Nothing was offered, and every registration that was seen was offline. */
      offlineOnly: boolean }> {
    catalog?.catch(() => undefined); // awaited below, after the registrations are read
    const rows = await this.database.transaction({ requestId: `registration-candidates:${target.harness ?? "auto"}`,
      operation: "registration.launch.candidates", placement: this.placement }, tx => tx.query({
      name: "registration_launch_candidates_v2", text: `SELECT r.owner_user_id,r.machine_id,r.harness,r.configuration_json,
        a.grant_limits,a.policy_limits FROM data.space_agent_registrations r
        JOIN data.space_members m ON m.space_id=r.space_id AND m.user_id=r.owner_user_id
        JOIN data.space_agent_registration_access a ON a.space_id=r.space_id AND a.owner_user_id=r.owner_user_id
          AND a.machine_id=r.machine_id AND a.harness=r.harness
        WHERE r.space_id=$1 AND ($2::text IS NULL OR r.harness=$2) AND a.grant_state='active' AND a.policy_state='enabled'
          AND ($3::text IS NULL OR r.owner_user_id=$3) AND ($4::text IS NULL OR r.machine_id=$4)
        ORDER BY r.owner_user_id,r.machine_id,r.harness LIMIT 101`,
      values: [this.placement.spaceId, target.harness ?? null, target.ownerUserId ?? null, target.machineId ?? null], maxRows: 101 }));
    if (rows.length > 100) throw new RegistrationAccessError("registration_candidates_limit", 409);
    const repositoryCatalog = await catalog;
    const candidates = rows.flatMap(row => {
      const configuration = parseSpaceAgentConfiguration(row.configuration_json);
      if (configuration.routing?.enabled === false) return [];
      const grant = parseRegistrationResourceLimits(row.grant_limits), policy = parseRegistrationResourceLimits(row.policy_limits);
      const declared = [...new Set([...(configuration.routing?.models ?? []), ...(configuration.model ? [configuration.model] : [])])];
      const models = declared.filter(model => grant.models.includes(model) && policy.models.includes(model));
      // No declared model means no model override. Declared models that are
      // not allowed never widen into the runtime default.
      if (declared.length && !models.length) return [];
      const directories = configuration.workspaceReferences.filter(value =>
        (!this.repositoryReader || !value.startsWith("repo:")) && grant.workspaces.includes(value) && policy.workspaces.includes(value));
      const workspaceReferences = [...new Set([...directories,
        ...(repositoryCatalog?.repositories ?? []).map(repo => `repo:${repo}`)])];
      if (!workspaceReferences.length && !target.managedWorkspace) return [];
      return [{ key: parseSpaceAgentRegistrationKey({ spaceId: this.placement.spaceId, ownerUserId: row.owner_user_id,
        machineId: row.machine_id, harness: row.harness }), description: configuration.routing?.description ?? "",
        models, workspaceReferences }];
    });
    const observed = await this.database.transaction({ requestId: `registration-models:${target.harness ?? "auto"}`,
      operation: "registration.launch.model-catalog", placement: this.placement }, tx => tx.query({
      name: "registration_launch_model_catalog_v2", text: `SELECT requested.owner,requested.machine,requested.harness,catalog.models,catalog.observed_at,parameter_catalog.parameters,parameter_catalog.parameter_model,parameter_catalog.parameters_observed_at
        FROM jsonb_to_recordset($1::jsonb) AS requested(owner text,machine text,harness text)
        LEFT JOIN LATERAL (SELECT i.presentation_json->'models' AS models,
          i.presentation_json->>'modelsObservedAt' AS observed_at
          FROM data.run_agent_registrations r JOIN data.instances i ON i.run_id=r.run_id
          WHERE r.space_id=$2 AND r.owner_user_id=requested.owner AND r.machine_id=requested.machine AND r.harness=requested.harness
            AND jsonb_typeof(i.presentation_json->'models')='array'
            AND CASE WHEN pg_input_is_valid(i.presentation_json->>'modelsObservedAt','timestamp with time zone')
              THEN (i.presentation_json->>'modelsObservedAt')::timestamptz BETWEEN statement_timestamp()-interval '24 hours' AND statement_timestamp()
              ELSE FALSE END
          ORDER BY (i.presentation_json->>'modelsObservedAt')::timestamptz DESC,i.instance_id LIMIT 1) catalog ON TRUE
        LEFT JOIN LATERAL (SELECT i.presentation_json->'parameters' AS parameters,
          i.presentation_json->>'model' AS parameter_model,i.presentation_json->>'parametersObservedAt' AS parameters_observed_at
          FROM data.run_agent_registrations r JOIN data.instances i ON i.run_id=r.run_id
          WHERE r.space_id=$2 AND r.owner_user_id=requested.owner AND r.machine_id=requested.machine AND r.harness=requested.harness
            AND jsonb_typeof(i.presentation_json->'parameters')='array'
            AND CASE WHEN pg_input_is_valid(i.presentation_json->>'parametersObservedAt','timestamp with time zone')
              THEN (i.presentation_json->>'parametersObservedAt')::timestamptz BETWEEN statement_timestamp()-interval '24 hours' AND statement_timestamp()
              ELSE FALSE END
          ORDER BY (i.presentation_json->>'parametersObservedAt')::timestamptz DESC,i.instance_id LIMIT 1) parameter_catalog ON TRUE`,
      values: [JSON.stringify(candidates.map(candidate => ({ owner: candidate.key.ownerUserId,
        machine: candidate.key.machineId, harness: candidate.key.harness }))),this.placement.spaceId], maxRows: 100 }));
    // Resolve only references explicitly granted to this registration. Directory
    // metadata is factual context, never a source of new launch permissions.
    return this.directory.transaction({ requestId: `registration-workspaces:${target.harness ?? "auto"}`,
      operation: "registration.launch.workspace-catalog" }, async tx => {
      const offered: RegistrationLaunchCandidate[] = [];
      const blocked: LaunchMachineBlock[] = [];
      let droppedOther = false;
      for (const candidate of candidates) {
        const workspaces = await tx.query({ name: "registration_launch_workspace_catalog_v1",
          text: `SELECT workspace_id,canonical_cwd,metadata_json FROM data.workspaces
            WHERE owner_user_id=$1 AND machine_id=$2 AND workspace_id=ANY($3::text[])
            ORDER BY workspace_id LIMIT 101`,
          values: [candidate.key.ownerUserId,candidate.key.machineId,candidate.workspaceReferences], maxRows: 101 });
        if (workspaces.length > 100) throw new RegistrationAccessError("registration_workspaces_limit", 409);
        // The daemons preparation can route to (see workspace()): online and
        // taking launch settings from the Hub registration.
        const daemons = await tx.query({ name: "registration_launch_daemon_facts_v7",
          text: `SELECT hostname,capabilities_json,metadata_json,connection_epoch,status,(SELECT name FROM data.machines machine
            WHERE machine.owner_user_id=$1 AND machine.machine_id=$2) AS machine_name,(SELECT auto_assign FROM data.machines machine
            WHERE machine.owner_user_id=$1 AND machine.machine_id=$2) AS auto_assign
            FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2
            ORDER BY (status='online') DESC, hostname LIMIT 8`,
          values: [candidate.key.ownerUserId,candidate.key.machineId], maxRows: 8 });
        // A known daemon that is not connected is the cause. Dropping it here
        // used to make the chooser say the machine had no registration.
        if (daemons.length > 0 && !daemons.some(row => row.status === "online")) {
          const machineName = typeof daemons[0]?.machine_name === "string" ? daemons[0].machine_name : "";
          blocked.push({ machineId: candidate.key.machineId, ...(machineName ? { machineName } : {}), reason: "daemon_offline" });
          continue;
        }
        const facts = await tx.query({ name: "registration_launch_observations_v3", text: `SELECT
          e.declaration_json,statement_timestamp() AS evaluated_at,
          (SELECT count(*)::int FROM control.registration_execution_allocations a
            WHERE a.owner_user_id=$1 AND a.machine_id=$2 AND a.state<>'released') AS machine_allocations,
          (SELECT count(*)::int FROM control.registration_execution_allocations a
            WHERE a.owner_user_id=$1 AND a.machine_id=$2 AND a.harness=$3 AND a.state<>'released') AS registration_allocations,
          q.remaining,q.observed_at,q.expires_at,q.source,q.windows_json,q.account_json
          FROM control.agent_registration_environments e
          ${currentRegistrationQuotaJoin("q")}
          WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=$3`,
          values: [candidate.key.ownerUserId,candidate.key.machineId,candidate.key.harness], maxRows: 1 });
        const fact = facts[0];
        const evaluatedAt = new Date(fact?.evaluated_at ?? Date.now()).toISOString();
        const environment = fact ? parseAgentRegistrationEnvironment(fact.declaration_json) : undefined;
        if (!environment?.enabled || environment.availableUntil && Date.parse(environment.availableUntil) <= Date.parse(evaluatedAt)) {
          droppedOther = true; continue;
        }
        const models = candidate.models.filter(model => environment.models.includes(model));
        if (candidate.models.length && !models.length) { droppedOther = true; continue; }
        const online = daemons.filter(row => row.status === "online" && daemonCapable(row, "registration_launch_v3"));
        const route = routableRegistrationLaunch(online, { runtimeDefaultOnly: !models.length,
          workspaceReferences: candidate.workspaceReferences, managedWorkspace: target.managedWorkspace === true,
          registeredWorkspaceIds: new Set(workspaces.map(row => String(row.workspace_id))) });
        if (!route) { droppedOther = true; continue; }
        const { daemon, workspaceReferences } = route;
        // Jev never sees a machine whose daemon cannot show the host abilities
        // the work needs; workspace() checks the same evidence again at launch.
        const machineResources = currentMachineResources(daemon, Date.parse(evaluatedAt));
        if (target.requiredHostCapabilities?.some(capability =>
            !machineResources?.hostCapabilities?.includes(capability))) { droppedOther = true; continue; }
        const directories = workspaces.filter(row => workspaceReferences.includes(String(row.workspace_id)));

        const quota = registrationQuotaReading(fact);
        const quotaWindows = currentRoutingQuotaWindows(fact?.windows_json, Date.now());
        const observation = observed.find(row => row.owner === candidate.key.ownerUserId &&
          row.machine === candidate.key.machineId && row.harness === candidate.key.harness);
        const modelCatalog = routingModelCatalogObservation(observation?.models, observation?.observed_at, Date.now())?.value;
        const parameterObservation = daemonCapable(daemon, "machine_routing_parameters_v1")
          ? harnessParameterObservation(observation?.parameters, observation?.parameters_observed_at,
              observation?.parameter_model, models.map(model => environment.modelAliases?.[model] ?? model), Date.now()) : undefined;
        offered.push({ ...candidate, workspaceReferences, models, modelCatalog, ...parameterObservation,
          modelAliases: environment.modelAliases,
          // A machine tag selects by the owner's name or id, never a hostname.
          machineName: String(daemon.machine_name || ""),
          // A launch addressed to this Machine (one of its registrations or its id) named it.
          ...(daemon.auto_assign === false && !target.machineId ? { autoAssign: false as const } : {}),
          ...(fact ? { observations: { evaluatedAt,
            machineResources,
            outstandingMachineAllocations: Number(fact.machine_allocations), outstandingRegistrationAllocations: Number(fact.registration_allocations),
            quota: quota ? { ...quota, assumed: false, source: fact.source,
              ...(quotaWindows.length ? { windows: quotaWindows } : {}) }
              : { remainingPercent: 100, assumed: true } } } : {}),
          supportsRequestedParameters: daemonCapable(daemon, "machine_routing_parameters_v1"),
          supportsRequestedEffort: daemonCapable(daemon, "machine_routing_effort_v1"), workspaces: [...workspaceReferences.flatMap(reference => {
            const repo = reference.startsWith("repo:") ? reference.slice(5) : undefined;
            return repo && repoSummonReference(repo) === repo ? [{ reference, repo,
              description: "Authorized registered repository", machineId: candidate.key.machineId }] : [];
          }), ...directories.map(row => ({ reference: row.workspace_id,
          canonicalCwd: row.canonical_cwd, machineId: candidate.key.machineId,
          description: typeof row.metadata_json?.displayName === "string"
            ? row.metadata_json.displayName.slice(0, 500) : "Registered workspace" }))] });
      }
      return { offered, blocked, offlineOnly: offered.length === 0 && blocked.length > 0 && !droppedOther };
    });
  }

}

function daemonCapable(row: QueryResultRow, capability: string): boolean {
  return Array.isArray(row.capabilities_json) && row.capabilities_json.includes(capability);
}

/** The part of one registration a launch can actually be routed to, by the
 * rules workspace() applies at preparation, or undefined when none. Offering
 * anything more lets the chooser pick a machine that preparation then refuses
 * with *_route_unavailable. `daemons` are the machine's online daemons that
 * take Hub registration launch settings. */
export function routableRegistrationLaunch(daemons: readonly QueryResultRow[], input: { runtimeDefaultOnly: boolean;
  workspaceReferences: string[]; registeredWorkspaceIds: ReadonlySet<string>; managedWorkspace: boolean }) {
  // The query already binds owner + Machine. Conflicting daemon records cannot
  // be disambiguated by a hostname or by choosing the first capable process.
  if (daemons.length !== 1) return undefined;
  // Only a daemon declaring registration_optional_model_v1 runs the runtime default.
  const routable = daemons.filter(row => !input.runtimeDefaultOnly || daemonCapable(row, "registration_optional_model_v1"));
  const daemon = routable[0];
  if (!daemon) return undefined;
  const workspaceReferences = input.workspaceReferences.filter(reference => reference.startsWith("repo:")
    || input.registeredWorkspaceIds.has(reference));
  if (!workspaceReferences.length && !(input.managedWorkspace && daemonCapable(daemon, "registration_managed_v1"))) {
    return undefined;
  }
  return { daemon, workspaceReferences };
}

/** Replays the durable abort, including a reservation that committed just before
 * its response was lost. Completed cancellation never permits a late reserve. */
export async function reconcileRegistrationPreparationCancellations(database: AuthorityDatabase, directory: AuthorityDatabase,
  channelId: string): Promise<number> {
  let discoveryFailure: unknown;
  try { await fenceInvalidPreparations(database, channelId); } catch (error) { discoveryFailure = error; }
  const rows = await database.transaction({ requestId: `registration-aborts:${crypto.randomUUID()}`,
    operation: "registration.launch.cancel-pending" }, tx => tx.query({ name: "registration_launch_cancel_pending_v2", text: `SELECT *
      FROM data.registration_launch_intents p WHERE channel_id=$1 AND state='aborted' AND cancellation_completed=FALSE
        AND NOT EXISTS (SELECT 1 FROM data.runs r WHERE r.run_id=p.run_id)
      ORDER BY updated_at,run_id LIMIT 10`, values: [channelId], maxRows: 10 }));
  const capacity = new PostgresRegistrationExecutionRepository(directory);
  const results = await Promise.allSettled(rows.map(async row => {
    await capacity.abortPreparation({ requestId: String(row.command_id), runId: String(row.run_id),
      sourceCommandId: String(row.command_id), actorUserId: String(row.actor_user_id),
      key: { spaceId: String(row.space_id), ownerUserId: String(row.owner_user_id), machineId: String(row.machine_id), harness: String(row.harness) } });
    await database.transaction({ requestId: String(row.command_id), operation: "registration.launch.cancel-confirm" }, tx => tx.query({
      name: "registration_launch_cancel_confirm_v1", text: `UPDATE data.registration_launch_intents SET cancellation_completed=TRUE
        WHERE run_id=$1 AND state='aborted'`, values: [row.run_id], maxRows: 0 }));
  }));
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  if (discoveryFailure) throw discoveryFailure;
  return rows.length;
}

/** How long a staged launch waits for its preparing request or an exact retry
 *  to commit. Preparation is one request of seconds; this bounds a lost one. */
export const REGISTRATION_PREPARATION_RETRY_WINDOW_SECONDS = 600;

async function fenceInvalidPreparations(database: AuthorityDatabase, channelId: string): Promise<void> {
  await database.transaction({ requestId: `registration-prepare-check:${crypto.randomUUID()}`,
    operation: "registration.launch.recheck" }, async tx => {
    // Staging and commit lock the Channel (runtime_new_work) before an intent;
    // so does this recheck. Claiming intents first deadlocked with a commit
    // holding the Channel and waiting for the same intent.
    await lockChannelLifecycle(tx, { channelId, capability: "runtime_new_work" });
    // Only the preparing request (or its exact retry) can commit. Once no
    // retry can still arrive, the preparation is abandoned: without this it
    // would hold its capacity reservation and recheck forever.
    const rows = await tx.query({ name: "registration_launch_recheck_claim_v3", text: `SELECT *,
        created_at<=clock_timestamp()-make_interval(secs => $2) AS abandoned FROM data.registration_launch_intents
      WHERE channel_id=$1 AND state='preparing' AND next_check_at<=clock_timestamp() ORDER BY next_check_at,run_id LIMIT 10 FOR UPDATE SKIP LOCKED`,
    values: [channelId, REGISTRATION_PREPARATION_RETRY_WINDOW_SECONDS], maxRows: 10 });
    for (const row of rows) {
      const key = { spaceId: String(row.space_id), ownerUserId: String(row.owner_user_id), machineId: String(row.machine_id), harness: String(row.harness) };
      let invalid = row.abandoned === true;
      if (!invalid) try {
        await requireRegistrationAdmission(tx, { key, channelId: String(row.channel_id), actorUserId: String(row.actor_user_id),
          requested: parseRegistrationResourceLimits(row.resources_json), fence: { key,
            grantRevision: Number(row.grant_revision), grantExecutionRevision: Number(row.grant_execution_revision),
            policyRevision: Number(row.policy_revision), policyExecutionRevision: Number(row.policy_execution_revision) } });
        if (row.source_message_id !== null) {
          // The same authorship rule as the launch reader: an Agent Run's own
          // summon stays valid, not only a Human's.
          const source = await tx.query({ name: "registration_launch_recheck_source_v2", text: `SELECT author_kind,author_id FROM data.messages
            WHERE space_id=$1 AND channel_id=$2 AND message_id=$3
              AND body_hash=$4 AND COALESCE(invocation_input_version,entity_version)=$5
              AND deleted_at IS NULL AND recalled_at IS NULL FOR SHARE`,
          values: [key.spaceId,row.channel_id,row.source_message_id,row.source_body_hash,row.source_revision], maxRows: 1 });
          invalid = !source[0] || !await messageAuthoredForActor(tx, { spaceId: key.spaceId, channelId: String(row.channel_id),
            messageId: String(row.source_message_id), authorKind: source[0].author_kind,
            authorId: source[0].author_id, actorUserId: String(row.actor_user_id) });
        }
      } catch (error) {
        if (!(error instanceof RegistrationAccessError) || error.status >= 500) throw error;
        invalid = true;
      }
      await tx.query({ name: "registration_launch_recheck_settle_v1", text: `UPDATE data.registration_launch_intents p SET
        state=CASE WHEN $2 THEN 'aborted' ELSE state END,next_check_at=clock_timestamp()+interval '15 seconds',updated_at=clock_timestamp()
        WHERE run_id=$1 AND state='preparing' AND NOT EXISTS (SELECT 1 FROM data.runs r WHERE r.run_id=p.run_id)`,
      values: [row.run_id,invalid], maxRows: 0 });
    }
  });
}

/** The daemon reports resources when they change, so the last observation of
 * its live connection is current; one from an earlier connection is not. */
/** A daemon row passes when it shows, on its live connection, every host
 * ability in the text[] parameter; an empty requirement always passes. */
const HOST_CAPABILITY_ROUTE_SQL = (parameter: string, alias = "") => `(cardinality(${parameter}::text[]) = 0 OR (
  ${alias}metadata_json->'machineResources'->>'connectionEpoch' = ${alias}connection_epoch::text
  AND COALESCE(${alias}metadata_json->'machineResources'->'hostCapabilities','[]'::jsonb) ?& ${parameter}::text[]))`;

function currentMachineResources(daemon: QueryResultRow, now: number) {
  const value = daemon.metadata_json?.machineResources;
  if (!value || typeof value !== "object" ||
      String((value as Record<string, unknown>).connectionEpoch) !== String(daemon.connection_epoch)) return undefined;
  return machineResourceObservation(value, now);
}
