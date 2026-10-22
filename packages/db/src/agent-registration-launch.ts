import { RegistrationPreparationAuthority } from "./registration-preparation-authority.js";
import { hostnameMetadata } from "./hostname-metadata.js";
import { registrationRepository, summonRepositoryCatalog,
  type RegistrationRepositoryCatalog } from "./registration-repository-authority.js";
import {
  agentLaunchExecutable,
  AUTO_LAUNCH_FIELDS,
  agentPresetForLauncher,
  agentPresetById,
  harnessCommandLine,
  harnessTooOld,
  parseHarnessInventory,
  digestCanonicalCloneCborV1,
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
  launchRefusal,
  validateHarnessParameterValues,
  type AutoLaunchTags,
  type HarnessTooOld,
  type HarnessSignedOut,
  type LaunchMachineBlock,
  type LaunchParameterEvidence,
  type DraftSummonIntent,
  type AgentRegistrationLaunch, utf8ByteLength, hasControlCharacter,
  currentRoutingQuotaWindows,
} from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { registrationInstructionsSpawnFields } from "./registration-instructions-spawn.js";
import { connectedAppsSpawnFields } from "./connected-apps-spawn.js";
import { spaceRulesSpawnFields } from "./space-rules-spawn.js";
import { RegistrationAccessError, registrationRouteRefusal } from "./agent-registration-errors.js";
import { PostgresRegistrationExecutionRepository } from "./agent-registration-execution.js";
import { requireRegistrationAdmission } from "./agent-registration-access.js";
import { REGISTRATION_KEY_SQL, registrationKeyValues } from "./agent-registration-rows.js";
import { currentRegistrationQuotaJoin, registrationQuotaReading } from "./agent-registration-quota-probe.js";
import { firstMessageSummonId, messageAuthoredForActor, readMessageInvocationSelections } from "./message-invocation-selections.js";
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
  /** The message this launch answers; its wrapper acknowledges it. Not a fence. */
  initialMessageId?: string;
  /** The Channel message this launch is drawn on. Not a fence, and not part of
   * the request identity: a retry of a launch staged before it still matches. */
  presentationMessageId?: string;
  /** Privacy-safe evidence for the selected model/effort and workspace. */
  parameterEvidence?: LaunchParameterEvidence;
  /** Owner's name for the Machine headroom routing bound. A hostname is not a name. */
  machineName?: string;
  /** A handoff predecessor's conversation, exported by its machine as it
   * stopped. Handed to the spawn as is; not part of the request identity and
   * not persisted, so a retry staged before the export arrived still matches,
   * and a recovered launch starts without it. */
  handoffContext?: Record<string, unknown>;
}

export interface RegistrationLaunchCandidate {
  key: SpaceAgentRegistrationKey;
  description: string;
  models: string[];
  modelCatalog?: RoutingModelOption[];
  parameters?: HarnessParameter[];
  parameterModel?: string;
  supportsRequestedEffort?: boolean;
  /** Its daemon applies a requested effort to the runtime's own default model. */
  supportsDefaultModelEffort?: boolean;
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
  /** The latest Run of this environment in the Space that failed to start
   * within the last STARTUP_FAILURE_WINDOW_MINUTES; routing ranks it last. */
  startupFailedAt?: string;
  /** The harness's median time from a connected Run to its first reply,
   * across every launch in the last RESPONSE_LATENCY_WINDOW_DAYS; absent with
   * fewer than RESPONSE_LATENCY_MIN_SAMPLES. Routing prefers the faster. */
  responseLatencyMs?: number;
}

/** The window and the least sample a harness's measured reply latency needs. */
export const RESPONSE_LATENCY_WINDOW_DAYS = 30;
export const RESPONSE_LATENCY_MIN_SAMPLES = 20;

/** A daemon that disconnected this recently, while no daemon of its Machine is
 * online, is taken to be restarting — a self-update, a dropped connection — and
 * stays the Machine's route: a launch prepared on it is queued and its spawn is
 * delivered when the daemon reconnects. The moment it went offline is the Hub's
 * own record (`machine_daemons.updated_at` of the offline row), never a claim. */
export const MACHINE_RECONNECT_GRACE_SECONDS = 120;
/** How long after its daemon went offline a launch routed in that grace waits
 * for it. Its spawn command expires then, so a later reconnect cannot start it,
 * and the coordinator fails the Launch as `machine_reconnect_expired`. */
export const MACHINE_RECONNECT_WAIT_SECONDS = 300;
/** A daemon row (`alias` with its dot) in the reconnect grace. */
const RECONNECTING_DAEMON_SQL = (alias: string) => `(${alias}status='offline'
  AND ${alias}updated_at>=statement_timestamp()-interval '${MACHINE_RECONNECT_GRACE_SECONDS} seconds'
  AND NOT EXISTS (SELECT 1 FROM data.machine_daemons online_daemon WHERE online_daemon.owner_user_id=${alias}owner_user_id
    AND online_daemon.machine_id=${alias}machine_id AND online_daemon.status='online'))`;
/** When a launch routed through a reconnecting daemon stops waiting for it. */
const RECONNECT_WAIT_UNTIL_SQL = (alias: string) =>
  `CASE WHEN ${alias}status='offline' THEN ${alias}updated_at+interval '${MACHINE_RECONNECT_WAIT_SECONDS} seconds' END`;

/** How long a failed start keeps an environment behind every other (the breaker). */
export const STARTUP_FAILURE_WINDOW_MINUTES = 30;
/** How long a start or turn refused as signed out keeps its registration out
 * of routing, unless its machine reports its harnesses again sooner. */
export const SIGNED_OUT_FAILURE_WINDOW_HOURS = 24;
/** Run phases a process that exits in them never started: the stored
 * (normalized) form of the phases a startup failure notice is posted for. */
const STARTUP_FAILURE_PHASES = ["wrapper_startup_failed", "auth_resolving", "workspace_registering",
  "relay_registering", "relay_register_retrying", "relay_auth_refresh_retrying", "runtime_starting"] as const;
export type RegistrationLaunchChooser = (input: {
  message: string; sourceSequence?: number; tags: AutoLaunchTags; candidates: RegistrationLaunchCandidate[];
  /** Registrations seen but not offered, so an empty list can name the real cause. */
  blocked?: readonly LaunchMachineBlock[];
  /** The input needs no repository, so a private managed directory is a valid choice. */
  managedWorkspace?: boolean;
  /** The conversation co-writes a page or discusses a passage of one: only the private managed directory is
   * offered, ready at once, with no repository to check out first. */
  managedOnly?: true;
  /** The mention being decided, when a message launches: Jev first reads
   * whether its author is asking an Agent to start, unless `launch:force`. */
  summon?: { text: string; start: number; end: number; authorKind: "user" | "agent";
    /** Jev read it as a request while the author typed, and the author sent it. */
    readInDraft?: true };
  /** A message that summons nobody: Jev first reads whether its author wants
   * an Agent to start now. */
  askToStart?: true;
  /** Told the harness as soon as Jev has read it, before the rest is chosen. */
  onHarness?: (harness: string) => Promise<void>;
}) => Promise<{ key: SpaceAgentRegistrationKey; model: string; modelResource?: string; effort?: string; parameters?: Record<string, string>; useRuntimeDefaultModel?: true;
  workspaceReference?: string; parameterEvidence?: LaunchParameterEvidence }>;

/** Whether Jev read anything for this launch: an intent, a harness's fit, or a choice with more than one
 * option. Otherwise every choice was the only option there was, and the constraints alone decided it. */
function jevDecided(evidence: LaunchParameterEvidence): boolean {
  return evidence.intent?.source === "jev" || evidence.fit !== undefined || evidence.choices.some(choice => !choice.only);
}

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
    if (raw.useRuntimeDefaultModel !== undefined && raw.useRuntimeDefaultModel !== true) {
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
    const { runMetadata: callerMetadata, presentationMessageId: _shownOn, handoffContext: _carried, ...identity } = input;
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
      // command reserves one.
      if (input.runId === undefined) {
        const reserved = await reserveNaturalKey(tx, { creationKey: `registration-launch:${input.actorUserId}:${input.commandId}`,
          channelId: input.channelId, scope: "instance", at: new Date().toISOString() });
        identities[0] = reserved.runId;
        identities[1] = reserved.instanceId ?? reserved.runId;
      } else {
        identities[0] = text(input.runId, 200);
        if (input.instanceId !== undefined) identities[1] = text(input.instanceId, 200);
      }
      const { body: _body, handoffContext: _context, ...persistedRequest } = input;
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
    if (options.error || (input.useRuntimeDefaultModel && tags.model) || (tags.repo && input.workspaceReference !== `repo:${repoSummonReference(tags.repo)}`) ||
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
  // A daemon in the reconnect grace routes too, and the route says until when
  // the launch waits for it (`reconnect_wait_until`).
  private async workspace(input: LaunchRequest) {
    const required = input.requiredHostCapabilities ?? [];
    // An effort on the runtime default model needs a daemon that carries it there.
    const defaultModelEffort = input.useRuntimeDefaultModel === true && Boolean(input.requirements.effort);
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
        const repoRoutes = (capabilities: readonly string[]) => tx.query({ name: "registration_launch_repo_route_v7",
          text: `SELECT hostname,${RECONNECT_WAIT_UNTIL_SQL("daemon.")} AS reconnect_wait_until FROM data.machine_daemons daemon
          WHERE owner_user_id=$1 AND machine_id=$2 AND (status='online' OR ${RECONNECTING_DAEMON_SQL("daemon.")})
            AND capabilities_json ? 'registration_launch_v3'
            AND ($3::text IS NULL OR capabilities_json ? $3)
            AND (NOT $4::boolean OR capabilities_json ? 'registration_optional_model_v1')
            AND (NOT $6::boolean OR capabilities_json ? 'machine_routing_parameters_v1')
            AND (NOT $7::boolean OR capabilities_json ? 'registration_default_effort_v1')
            AND ${HOST_CAPABILITY_ROUTE_SQL("$5")} LIMIT 2 FOR SHARE`,
          values: [input.key.ownerUserId,input.key.machineId,reference === undefined ? "registration_managed_v1" : null,
            input.useRuntimeDefaultModel === true, capabilities, Object.keys(input.requirements.parameters ?? {}).length > 0,
            defaultModelEffort], maxRows: 2 });
        const routes = await repoRoutes(required);
        const unrouted = reference === undefined ? "registration_managed_route_unavailable" : "registration_repo_route_unavailable";
        if (!routes.length) throw await refuse(unrouted, () => repoRoutes([]), input.key);
        if (routes.length !== 1) throw new RegistrationAccessError(unrouted, 409);
        const managedKey = `registration-${(await digestCanonicalCloneCborV1([input.key,input.commandId])).slice(0,48)}`;
        // The flag marks an unregistered cwd.
        return { hostname: routes[0]!.hostname, reconnect_wait_until: routes[0]!.reconnect_wait_until,
          canonical_cwd: `.xmatrix-management/${managedKey}`, managed_key: managedKey,
          ...(repo ? { remote_repo: repo } : {}), metadata_json: { displayName: repo ?? "xMatrix", managedWorkspaceKey: managedKey,
            syntheticManagedWorkspace: true, ...(repo ? { remoteRepo: repo } : {}) } };
      }
      const workspaceRoutes = (capabilities: readonly string[]) => tx.query({ name: "registration_launch_workspace_v6",
        text: `SELECT w.canonical_cwd,w.metadata_json,d.hostname,${RECONNECT_WAIT_UNTIL_SQL("d.")} AS reconnect_wait_until
        FROM data.workspaces w JOIN data.machine_daemons d ON d.owner_user_id=w.owner_user_id AND d.machine_id=w.machine_id
        WHERE w.workspace_id=$1 AND w.owner_user_id=$2 AND w.machine_id=$3 AND (d.status='online' OR ${RECONNECTING_DAEMON_SQL("d.")})
          AND d.capabilities_json ? 'registration_launch_v3'
          AND (NOT $4::boolean OR d.capabilities_json ? 'registration_optional_model_v1')
          AND (NOT $6::boolean OR d.capabilities_json ? 'machine_routing_parameters_v1')
          AND (NOT $7::boolean OR d.capabilities_json ? 'registration_default_effort_v1')
          AND ${HOST_CAPABILITY_ROUTE_SQL("$5", "d.")} LIMIT 1 FOR SHARE OF w,d`,
        values: [input.workspaceReference,input.key.ownerUserId,input.key.machineId,input.useRuntimeDefaultModel === true,
          capabilities, Object.keys(input.requirements.parameters ?? {}).length > 0, defaultModelEffort], maxRows: 1 });
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
      // A natural Instance id carries its ordinal; the counter skips the
      // historical >=8e15 addresses, which are not a spawn counter.
      const ordinal = await instanceOrdinalFor(tx, input.channelId, String(row.instance_id));
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
      const connectedApps = await connectedAppsSpawnFields(tx, input.key.spaceId);
      const payload = withInitialMessageSource({ type: "machine_spawn_agent", requestId: row.control_id, spaceId: input.key.spaceId,
        channelId: input.channelId, runId: row.run_id, instanceId: row.instance_id, launchId: row.launch_id,
        executionKey: row.execution_key, registration: registrationLaunchBindingForDaemon(binding), identityId: row.instance_id, resumeSessionKey,
        ...(input.handoffContext ? { handoffContext: input.handoffContext } : {}),
        ...registrationLaunchSpawnFields(launch, input.key.harness),
        agentName: row.display_name, prompt: input.body,
        // The daemon places a non-repository managed directory by this key.
        ...(workspace.managed_key && !workspace.remote_repo ? { managementSpaceId: workspace.managed_key } : {}),
        ...(initialMessageId !== undefined ? { sourceMessageId: initialMessageId } : {}),
        context: { ...(!input.useRuntimeDefaultModel ? { requestedModel: allocation.runtimeModel } : {}),
          ...(input.requirements.effort ? { requestedEffort: input.requirements.effort } : {}),
          ...(input.requirements.parameters ? { requestedParameters: input.requirements.parameters } : {}) },
        ...registrationInstructionsSpawnFields(configuration), ...spaceRules, ...connectedApps,
        ...(workspace.remote_repo ? { remoteRepo: workspace.remote_repo, runWorktree: true } : {}),
        workspace: { ...(workspace.managed_key ? { managedKey: workspace.managed_key, metadata: workspace.metadata_json } : {}), ownerUserId: input.key.ownerUserId, machineId: input.key.machineId, hostId: workspace.hostname ?? "", hostname: workspace.hostname ?? undefined,
          canonicalCwd: workspace.canonical_cwd, displayName: String(workspace.metadata_json?.displayName ?? "Workspace"),
          visibility: "private", createdAt: at, updatedAt: at, lastSeenAt: at } }, messageSource);
      // The spawn command's id is how a delete of a still-starting Instance waits
      // for that exact spawn before abandoning it.
      const metadata = { ...input.runMetadata, machineId: input.key.machineId, hostId: workspace.hostname ?? "", hostname: workspace.hostname ?? undefined, executionKey: row.execution_key, resumeSessionKey,
        spawnControlId: row.control_id,
        // Routed to a daemon that is reconnecting: this first spawn waits for it
        // until then, and no longer (the coordinator bounds its command).
        ...(workspace.reconnect_wait_until ? { machineReconnect: { controlId: row.control_id,
          waitUntil: new Date(workspace.reconnect_wait_until).toISOString() } } : {}),
        ...(workspace.managed_key ? { managedWorkspaceKey: workspace.managed_key } : {}),
        ...(initialMessageId !== undefined ? { sourceMessageId: initialMessageId } : {}),
        summonedByUserId: input.actorUserId, identityKind: "instance",
        requestedRuntimeModel: allocation.runtimeModel ?? null, modelResource: resources.models[0] ?? null,
        agentName: row.display_name, useRuntimeDefaultModel: input.useRuntimeDefaultModel === true,
        ...(workspace.remote_repo ? { remoteRepo: workspace.remote_repo, runWorktree: true } : {}),
        ...(input.parameterEvidence ? { routingDecision: { source: jevDecided(input.parameterEvidence) ? "jev" : "deterministic",
          parameters: input.parameterEvidence, rows: [], machine: boundMachine(input.key.machineId, input.machineName) } } : {}) };
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
      await tx.query({ name: "registration_launch_instance_v1", text: `INSERT INTO data.instances
        (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'offline',1,$5,$5)`, values: [row.instance_id,row.run_id,input.channelId,ordinal,at], maxRows: 0 });
      // Delivery reads the source only from this column and drops the copy in
      // the payload, so a Launch without it starts a turn tied to no message.
      await tx.query({ name: "registration_launch_delivery_v2", text: `INSERT INTO data.agent_launches
        (launch_id,space_id,channel_id,trigger_id,launch_kind,owner_user_id,run_id,instance_id,
         execution_key,control_id,machine_id,hostname,state,spawn_payload_json,next_attempt_at,created_at,updated_at,prepared_at,
         initial_source_json)
        VALUES ($1,$2,$3,$4,'registration',$5,$6,$7,$8,$9,$10,$11,'prepared',$12::jsonb,$13,$13,$13,$13,$14::jsonb)`,
      values: [row.launch_id,input.key.spaceId,input.channelId,input.sourceMessageId ?? input.presentationMessageId ?? input.commandId,input.key.ownerUserId,row.run_id,row.instance_id,
        row.execution_key,row.control_id,input.key.machineId,workspace.hostname,JSON.stringify(payload),at,
        messageSource ? JSON.stringify(messageSource) : null], maxRows: 0 });
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
    // Dispatch callers can carry services and transient picker state. Only
    // these source fields may overlay the immutable persisted launch request.
    return this.prepare({ ...row.launch_request_json, commandId: input.commandId, actorUserId: input.actorUserId,
      channelId: input.channelId, sourceMessageId: input.sourceMessageId,
      selectionIndex: input.selectionIndex, body: input.body });
  }

  /** Consume stored invocation intent. Capability selections pick among currently
   * authorized locations; explicit registration selections keep their tuple. */
  async dispatchFromMessage(input: {
    commandId: string; actorUserId: string; channelId: string; sourceMessageId: string; body: string;
    /** The author's "launch anyway" for one mention Jev read as a non-request:
     * only that summon is prepared, as if it carried `launch:force`. */
    forceMention?: string;
    /** Jev's reading of each summon while the author typed, by its text; the
     * author sent the message knowing it, so it answers the intent question. */
    draftIntents?: ReadonlyArray<DraftSummonIntent>;
  }, choose?: RegistrationLaunchChooser) {
    const actorUserId = text(input.actorUserId), channelId = text(input.channelId),
      sourceMessageId = text(input.sourceMessageId), commandId = text(input.commandId, 200);
    const { source, writesPage } = await this.database.transaction({ requestId: commandId,
      operation: "registration.launch.read-source", placement: this.placement }, async tx => {
      const source = await readMessageInvocationSelections(tx, { deriveFromText: true, spaceId: this.placement.spaceId,
        channelId, messageId: sourceMessageId, actorUserId, body: input.body });
      // A conversation that co-writes a page, or discusses a passage of one (a comment, §4.2), has its Agent
      // write the page (pages-live-document.md §4.2).
      const writesPage = source?.selections.length ? (await tx.query({ name: "registration_launch_writes_page_v1",
        text: `SELECT 1 FROM data.page_co_writing WHERE space_id=$1 AND conversation_id=$2 AND ended_at IS NULL
          UNION ALL SELECT 1 FROM data.page_links WHERE space_id=$1 AND conversation_id=$2
            AND anchor_json IS NOT NULL AND resolved_at IS NULL
          LIMIT 1`,
        values: [this.placement.spaceId, channelId], maxRows: 1 })).length > 0 : false;
      return { source, writesPage };
    });
    if (!source?.selections.length) {
      return { selectionCount: 0, prepared: [], rejected: [] };
    }
    const prepared: Array<{ runId: string; instanceId: string; launchId: string; reused: boolean }> = [];
    const rejected: Array<{ selectionIndex: number; code: string; sourceMention: string; tooOld?: HarnessTooOld;
      signedOut?: HarnessSignedOut }> = [];
    // The summon as written, address through its last condition: the text the
    // web parses from the message and binds this launch or refusal to.
    const summonText = (selection: { start: number; end: number; text: string }) =>
      input.body.slice(selection.start, selectionLaunchConditions(input.body, selection).end);
    // A refusal keeps what its error says is too old or signed out, so the reply can name it.
    const refused = (selectionIndex: number, selection: { start: number; end: number; text: string }, code: string, error: unknown) => {
      const tooOld = error instanceof RegistrationAccessError ? error.tooOld : undefined;
      const signedOut = error instanceof RegistrationAccessError ? error.signedOut : undefined;
      rejected.push({ selectionIndex, code, sourceMention: summonText(selection), ...(tooOld ? { tooOld } : {}),
        ...(signedOut ? { signedOut } : {}) });
    };
    for (const [selectionIndex, selection] of source.selections.entries()) {
      if (input.forceMention !== undefined && summonText(selection) !== input.forceMention) continue;
      try {
        const recovered = await this.recoverFromMessage({ ...input, commandId: `${commandId}:${selectionIndex}`, selectionIndex });
        if (recovered) { prepared.push(recovered); continue; }
        const options = selectionLaunchConditions(input.body, selection);
        if (options.error) throw new RegistrationAccessError("invalid_registration_launch", 400);
        const draftRead = input.forceMention === undefined && source.authorKind === "user"
          ? input.draftIntents?.find(item => item.start === selection.start && item.end === options.end &&
            item.mention === summonText(selection))?.choice : undefined;
        if (draftRead !== undefined && draftRead !== "summon" && options.tags.launch !== "force") {
          rejected.push({ selectionIndex, code: `summon_intent_${draftRead}`, sourceMention: summonText(selection) });
          continue;
        }
        // A conversation without a requested repository/directory can start in
        // a daemon-owned cwd, even before the owner registers any workspaces.
        const managedWorkspace = !options.tags.repo && !options.tags.pwd;
        // Writing a page needs no checkout: its Agent starts at once in that cwd, and no repository is read.
        // A comment that wants code says so with `repo:`/`pwd:`.
        const managedOnly = writesPage && managedWorkspace;
        // Read alongside the candidates: the repository list comes from GitHub.
        const repositoryCatalog = managedOnly ? undefined
          : summonRepositoryCatalog(this.repositoryReader, actorUserId, options.tags.repo);
        const target = selection.target.kind === "registration"
          ? parseSpaceAgentRegistrationKey(selection.target.key)
          : selection.target.kind === "capability" ? { harness: selection.target.harness }
          // `@auto` reaches every registration its conditions allow.
          : { ...(options.tags.harness ? { harness: canonicalRegistrationHarness(options.tags.harness) } : {}),
            ...(options.tags.machine?.startsWith("machine:") ? { machineId: options.tags.machine } : {}) };
        const listed = await this.candidatesFor({ ...target, managedWorkspace }, repositoryCatalog);
        const candidates = listed.offered;
        if (!candidates.length) {
          const refusal = listed.offlineOnly ? { code: "registration_daemon_offline" }
            : launchRefusal("registration_not_found", options.tags.machine, listed.blocked);
          throw new RegistrationAccessError(refusal.code, refusal.code === "registration_daemon_offline" ? 409 : 404, refusal.tooOld, refusal.signedOut);
        }
        if (!choose) {
          rejected.push({ selectionIndex, code: "registration_selection_unconfigured", sourceMention: summonText(selection) });
          continue;
        }
        let selected: Awaited<ReturnType<RegistrationLaunchChooser>>;
        try {
          selected = await choose({ message: input.body, sourceSequence: source.sourceSequence, candidates, managedWorkspace,
            ...(managedOnly ? { managedOnly } : {}), blocked: listed.blocked,
            tags: input.forceMention !== undefined ? { ...options.tags, launch: "force" } : options.tags,
            summon: { text: summonText(selection), start: selection.start, end: options.end, authorKind: source.authorKind,
              ...(draftRead === "summon" ? { readInDraft: true as const } : {}) } });
        }
        catch (error) {
          // A model or its input read failed before any launch allocation. Do not
          // store provider text or substitute a server-selected configuration.
          const code = error instanceof RegistrationAccessError &&
            REGISTRATION_PREPARATION_REJECTION_CODES.includes(error.code)
            ? error.code : "registration_selection_failed";
          refused(selectionIndex, selection, code, error);
          continue;
        }
        const candidate = candidates.find(item => sameAgentRegistration(item.key, selected.key) && item.key.spaceId === selected.key.spaceId);
        if (!candidate || !selectedModelGranted(candidate, selected) || (selected.workspaceReference === undefined
            ? !managedWorkspace : !candidate.workspaceReferences.includes(selected.workspaceReference))) {
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
          refused(selectionIndex, selection, error.code, error);
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
    /** An environment that cannot take this work (it just failed to start it). */
    excludeRegistration?: SpaceAgentRegistrationKey;
    commandId: string; actorUserId: string; channelId: string; body: string; runMetadata?: Record<string, unknown>;
    runId?: string; instanceId?: string;
    initialMessageId?: string; presentationMessageId?: string;
    /** Constraints the caller's own text states. */
    tags?: AutoLaunchTags;
    /** Capabilities the work needs; those a daemon can prove gate where it runs. */
    requiredCapabilities?: readonly string[];
    /** A handoff predecessor's conversation for the successor's spawn. */
    handoffContext?: Record<string, unknown>;
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
    // Read alongside the candidates: the repository list comes from GitHub.
    const repositoryCatalog = summonRepositoryCatalog(this.repositoryReader, actorUserId, input.tags?.repo);
    const requiredHostCapabilities = hostObservedRequirements(input.requiredCapabilities ?? []);
    const listed = await this.candidatesFor({ managedWorkspace: true, requiredHostCapabilities }, repositoryCatalog);
    const candidates = listed.offered
      .filter(candidate => !excluded || !sameAgentRegistration(candidate.key, excluded))
      .filter(candidate => !input.excludeRegistration || !sameAgentRegistration(candidate.key, input.excludeRegistration));
    if (!candidates.length) {
      // Say which requirement left nothing, rather than that nothing exists.
      if (requiredHostCapabilities.length && (await this.candidatesFor({ managedWorkspace: true }, repositoryCatalog)).offered.length) {
        throw new RegistrationAccessError("registration_capability_unavailable", 409);
      }
      const refusal = listed.offlineOnly ? { code: "registration_daemon_offline" }
        : launchRefusal("registration_not_found", input.tags?.machine, listed.blocked);
      throw new RegistrationAccessError(refusal.code, refusal.code === "registration_daemon_offline" ? 409 : 404, refusal.tooOld, refusal.signedOut);
    }
    // A caller may constrain the directory or repository it states.
    const tags: AutoLaunchTags = { ...input.tags };
    const selected = await choose({ message: input.body, tags, candidates, blocked: listed.blocked, managedWorkspace: true });
    const candidate = candidates.find(item => sameAgentRegistration(item.key, selected.key) && item.key.spaceId === selected.key.spaceId);
    if (!candidate || !selectedModelGranted(candidate, selected) || (selected.workspaceReference !== undefined &&
        !candidate.workspaceReferences.includes(selected.workspaceReference)) ||
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
      ...(input.initialMessageId !== undefined ? { initialMessageId: text(input.initialMessageId) } : {}),
      ...(input.presentationMessageId !== undefined ? { presentationMessageId: text(input.presentationMessageId) } : {}),
      ...(candidate.machineName ? { machineName: candidate.machineName } : {}),
      ...(input.handoffContext ? { handoffContext: input.handoffContext } : {}),
      ...selectedParameters(selected, candidate.key.harness) };
    return this.withHost(commandId, await this.prepare(request));
  }

  /**
   * Where a Run that failed to start came from, when that start may be retried
   * once on another Agent: an `@auto` summon, or xMatrix's summon for a first
   * message that named nobody, dispatched from its message. An Agent the author
   * named, an any-input launch and such a retry itself (an any-input launch)
   * have none. `readBody` reads the message as its author may.
   */
  async startupFallbackOrigin(input: { commandId: string; channelId: string; runId: string;
    readBody: (actorUserId: string, sourceSequence: number) => Promise<string | undefined> }): Promise<{
      actorUserId: string; sourceMessageId: string; body: string; sourceMention: string; tags: AutoLaunchTags;
      failed: SpaceAgentRegistrationKey } | undefined> {
    const commandId = text(input.commandId, 200), channelId = text(input.channelId), runId = text(input.runId);
    const row = (await this.database.transaction({ requestId: commandId, operation: "registration.launch.fallback-origin",
      placement: this.placement }, tx => tx.query({ name: "registration_launch_fallback_origin_v1", text: `SELECT
        intent.actor_user_id,intent.source_message_id,intent.selection_index,intent.owner_user_id,intent.machine_id,
        intent.harness,message.timeline_sequence
        FROM data.registration_launch_intents intent JOIN data.messages message ON message.space_id=intent.space_id
          AND message.channel_id=intent.channel_id AND message.message_id=intent.source_message_id
        WHERE intent.run_id=$1 AND intent.channel_id=$2 AND intent.space_id=$3 AND intent.state='committed'
          AND intent.command_id LIKE 'registration-launch%'`,
      values: [runId, channelId, this.placement.spaceId], maxRows: 1 })))[0];
    if (!row) return undefined;
    const actorUserId = String(row.actor_user_id), sourceMessageId = String(row.source_message_id);
    const body = await input.readBody(actorUserId, Number(row.timeline_sequence));
    if (body === undefined) return undefined;
    let source: Awaited<ReturnType<typeof readMessageInvocationSelections>>;
    try {
      source = await this.database.transaction({ requestId: commandId, operation: "registration.launch.fallback-source",
        placement: this.placement }, tx => readMessageInvocationSelections(tx, { deriveFromText: true,
        spaceId: this.placement.spaceId, channelId, messageId: sourceMessageId, actorUserId, body }));
    } catch (error) {
      // An edited, deleted or no longer authorized message starts nothing new.
      if (error instanceof MessageAuthorityError && error.status < 500) return undefined;
      throw error;
    }
    const selection = source?.selections[Number(row.selection_index)];
    if (!selection || selection.target.kind !== "auto" && !sourceMessageId.startsWith(firstMessageSummonId(""))) return undefined;
    const options = selectionLaunchConditions(body, selection);
    if (options.error) return undefined;
    // The author already asked for work; their other conditions still bind the retry.
    const { launch: _launch, ...tags } = options.tags;
    return { actorUserId, sourceMessageId, body, sourceMention: body.slice(selection.start, options.end), tags,
      failed: parseSpaceAgentRegistrationKey({ spaceId: this.placement.spaceId, ownerUserId: row.owner_user_id,
        machineId: row.machine_id, harness: row.harness }) };
  }

  /** A message that summons nobody: the harness Jev reads its author wants
   * started, or Jev's `start_intent_declined`. Nothing is prepared here; the
   * caller summons that harness with an ordinary `@<harness>` message. */
  async readHarnessToStart(input: { actorUserId: string; body: string; onHarness?: (harness: string) => Promise<void> },
    choose: RegistrationLaunchChooser): Promise<string> {
    const repositoryCatalog = summonRepositoryCatalog(this.repositoryReader, text(input.actorUserId), undefined);
    const listed = await this.candidatesFor({ managedWorkspace: true }, repositoryCatalog);
    const candidates = listed.offered;
    if (!candidates.length) {
      const refusal = launchRefusal("registration_not_found", undefined, listed.blocked);
      throw new RegistrationAccessError(refusal.code, 404, refusal.tooOld, refusal.signedOut);
    }
    const selected = await choose({ message: input.body, tags: {}, candidates, managedWorkspace: true, askToStart: true,
      ...(input.onHarness ? { onHarness: input.onHarness } : {}) });
    return selected.key.harness;
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
      name: "registration_launch_candidates_v3", text: `SELECT r.owner_user_id,r.machine_id,r.harness,r.configuration_json,
        a.grant_limits,a.policy_limits,p.description AS profile_description FROM data.space_agent_registrations r
        JOIN data.space_members m ON m.space_id=r.space_id AND m.user_id=r.owner_user_id
        JOIN data.space_agent_registration_access a ON a.space_id=r.space_id AND a.owner_user_id=r.owner_user_id
          AND a.machine_id=r.machine_id AND a.harness=r.harness
        LEFT JOIN data.space_harness_profiles p ON p.space_id=r.space_id AND p.harness=r.harness
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
        machineId: row.machine_id, harness: row.harness }),
        // The Space's profile of the harness is the one description routing reads.
        description: typeof row.profile_description === "string" ? row.profile_description : "",
        models, workspaceReferences }];
    });
    const [observed, latencies] = await this.database.transaction({ requestId: `registration-models:${target.harness ?? "auto"}`,
      operation: "registration.launch.model-catalog", placement: this.placement }, async tx => [await tx.query({
      name: "registration_launch_model_catalog_v5", text: `SELECT requested.owner,requested.machine,requested.harness,catalog.models,catalog.observed_at,parameter_catalog.parameters,parameter_catalog.parameter_model,parameter_catalog.parameters_observed_at,startup.startup_failed_at,signed_out.signed_out_at
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
          ORDER BY (i.presentation_json->>'parametersObservedAt')::timestamptz DESC,i.instance_id LIMIT 1) parameter_catalog ON TRUE
        LEFT JOIN LATERAL (SELECT max(run.finished_at) AS startup_failed_at
          FROM data.run_agent_registrations r JOIN data.runs run ON run.run_id=r.run_id
          WHERE r.space_id=$2 AND r.owner_user_id=requested.owner AND r.machine_id=requested.machine AND r.harness=requested.harness
            AND run.status IN ('failed','exited') AND run.finished_at>=statement_timestamp()-interval '${STARTUP_FAILURE_WINDOW_MINUTES} minutes'
            AND run.metadata_json->'stopRequest' IS NULL AND run.metadata_json->'executionCancellation' IS NULL
            AND (run.metadata_json->'spawnResult'->>'ok'='false'
              OR run.metadata_json->'invocationProgress'->>'phase'=ANY($3::text[]))) startup ON TRUE
        LEFT JOIN LATERAL (SELECT refused.at AS signed_out_at FROM (SELECT max(GREATEST(
            CASE WHEN pg_input_is_valid(run.metadata_json->>'signedOutAt','timestamp with time zone')
              THEN (run.metadata_json->>'signedOutAt')::timestamptz END,
            CASE WHEN run.metadata_json->'invocationProgress'->'operationFailure'->>'code'='harness_signed_out'
              THEN run.finished_at END)) AS at
          FROM data.run_agent_registrations r JOIN data.runs run ON run.run_id=r.run_id
          WHERE r.space_id=$2 AND r.owner_user_id=requested.owner AND r.machine_id=requested.machine AND r.harness=requested.harness
            AND run.updated_at>=statement_timestamp()-interval '${SIGNED_OUT_FAILURE_WINDOW_HOURS} hours') refused
          WHERE refused.at IS NOT NULL AND NOT EXISTS (SELECT 1
            FROM data.run_agent_registrations r JOIN data.instances i ON i.run_id=r.run_id
            JOIN data.messages m ON m.space_id=$2 AND m.author_kind='agent' AND m.author_id=i.instance_id
              AND m.sent_at>refused.at AND m.message_id NOT LIKE 'turn-failure:%'
            WHERE r.space_id=$2 AND r.owner_user_id=requested.owner AND r.machine_id=requested.machine
              AND r.harness=requested.harness)) signed_out ON TRUE`,
      values: [JSON.stringify(candidates.map(candidate => ({ owner: candidate.key.ownerUserId,
        machine: candidate.key.machineId, harness: candidate.key.harness }))),this.placement.spaceId,
        [...STARTUP_FAILURE_PHASES]], maxRows: 100 }),
      // How long each harness takes to answer is the harness's own, measured
      // over every launch: a new Space has none of its own to go on.
      await tx.query({ name: "registration_launch_response_latency_v1", text: `SELECT
          spawn_payload_json->'registration'->'key'->>'harness' AS harness,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_reply_at-connected_at)*1000) AS p50_ms
        FROM data.agent_launches
        WHERE created_at>=statement_timestamp()-interval '${RESPONSE_LATENCY_WINDOW_DAYS} days' AND first_reply_at>=connected_at
          AND spawn_payload_json->'registration'->'key'->>'harness'=ANY($1::text[])
        GROUP BY 1 HAVING count(*)>=${RESPONSE_LATENCY_MIN_SAMPLES}`,
        values: [[...new Set(candidates.map(candidate => candidate.key.harness))]], maxRows: 100 })] as const);
    const responseLatency = new Map(latencies.map(row => [String(row.harness), Math.round(Number(row.p50_ms))]));
    // Resolve only references explicitly granted to this registration. Directory
    // metadata is factual context, never a source of new launch permissions.
    return this.directory.transaction({ requestId: `registration-workspaces:${target.harness ?? "auto"}`,
      operation: "registration.launch.workspace-catalog" }, async tx => {
      const offered: RegistrationLaunchCandidate[] = [];
      const blocked: LaunchMachineBlock[] = [];
      /** Offered through a daemon in the reconnect grace. */
      const waiting = new Set<RegistrationLaunchCandidate>();
      let droppedOther = false;
      for (const candidate of candidates) {
        const workspaces = await tx.query({ name: "registration_launch_workspace_catalog_v1",
          text: `SELECT workspace_id,canonical_cwd,metadata_json FROM data.workspaces
            WHERE owner_user_id=$1 AND machine_id=$2 AND workspace_id=ANY($3::text[])
            ORDER BY workspace_id LIMIT 101`,
          values: [candidate.key.ownerUserId,candidate.key.machineId,candidate.workspaceReferences], maxRows: 101 });
        if (workspaces.length > 100) throw new RegistrationAccessError("registration_workspaces_limit", 409);
        // The daemons preparation can route to (see workspace()): online, or
        // in the reconnect grace, and taking launch settings from the Hub registration.
        const daemons = await tx.query({ name: "registration_launch_daemon_facts_v8",
          text: `SELECT hostname,capabilities_json,metadata_json,connection_epoch,status,
            status='offline' AND updated_at>=statement_timestamp()-interval '${MACHINE_RECONNECT_GRACE_SECONDS} seconds' AS reconnecting,
            (SELECT name FROM data.machines machine
            WHERE machine.owner_user_id=$1 AND machine.machine_id=$2) AS machine_name,(SELECT auto_assign FROM data.machines machine
            WHERE machine.owner_user_id=$1 AND machine.machine_id=$2) AS auto_assign
            FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2
            ORDER BY (status='online') DESC, hostname LIMIT 8`,
          values: [candidate.key.ownerUserId,candidate.key.machineId], maxRows: 8 });
        // A known daemon that is not connected is the cause. Dropping it here
        // used to make the chooser say the machine had no registration. One
        // that dropped moments ago is restarting: the launch waits for it.
        const online = daemons.filter(row => row.status === "online");
        const reconnecting = online.length ? [] : daemons.filter(row => row.reconnecting === true);
        const offline = () => {
          const machineName = typeof daemons[0]?.machine_name === "string" ? daemons[0].machine_name : "";
          blocked.push({ machineId: candidate.key.machineId, ...(machineName ? { machineName } : {}), reason: "daemon_offline" });
        };
        if (daemons.length > 0 && !online.length && !reconnecting.length) { offline(); continue; }
        // A reconnecting machine that cannot be offered stays refused as offline.
        const drop = () => { if (reconnecting.length) offline(); else droppedOther = true; };
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
          drop(); continue;
        }
        const models = candidate.models.filter(model => environment.models.includes(model));
        if (candidate.models.length && !models.length) { drop(); continue; }
        const route = routableRegistrationLaunch((online.length ? online : reconnecting)
          .filter(row => daemonCapable(row, "registration_launch_v3")), { runtimeDefaultOnly: !models.length,
          workspaceReferences: candidate.workspaceReferences, managedWorkspace: target.managedWorkspace === true,
          registeredWorkspaceIds: new Set(workspaces.map(row => String(row.workspace_id))) });
        if (!route) { drop(); continue; }
        const { daemon, workspaceReferences } = route;
        // A harness the machine reports older than the version xMatrix can
        // talk to would only fail at startup: it is named, never routed to.
        const tooOld = harnessTooOldOn(daemon, candidate.key.harness);
        if (tooOld) {
          blocked.push({ machineId: candidate.key.machineId, ...(tooOld.machineName ? { machineName: tooOld.machineName } : {}),
            reason: "harness_outdated", tooOld });
          continue;
        }
        // A harness its machine reports signed out answers nothing sent to it:
        // it is named, with its sign-in, and never routed to.
        const signedOut = harnessSignedOutOn(daemon, candidate.key, observed.find(row => row.owner === candidate.key.ownerUserId &&
          row.machine === candidate.key.machineId && row.harness === candidate.key.harness)?.signed_out_at);
        if (signedOut) {
          blocked.push({ machineId: candidate.key.machineId, ...(signedOut.machineName ? { machineName: signedOut.machineName } : {}),
            reason: "harness_signed_out", signedOut });
          continue;
        }
        // Jev never sees a machine whose daemon cannot show the host abilities
        // the work needs; workspace() checks the same evidence again at launch.
        const machineResources = currentMachineResources(daemon, Date.parse(evaluatedAt));
        if (target.requiredHostCapabilities?.some(capability =>
            !machineResources?.hostCapabilities?.includes(capability))) { drop(); continue; }
        const directories = workspaces.filter(row => workspaceReferences.includes(String(row.workspace_id)));

        const quota = registrationQuotaReading(fact);
        const quotaWindows = currentRoutingQuotaWindows(fact?.windows_json, Date.now());
        const observation = observed.find(row => row.owner === candidate.key.ownerUserId &&
          row.machine === candidate.key.machineId && row.harness === candidate.key.harness);
        const modelCatalog = routingModelCatalogObservation(observation?.models, observation?.observed_at, Date.now())?.value;
        const parameterObservation = daemonCapable(daemon, "machine_routing_parameters_v1")
          ? harnessParameterObservation(observation?.parameters, observation?.parameters_observed_at,
              observation?.parameter_model, models.map(model => environment.modelAliases?.[model] ?? model), Date.now()) : undefined;
        const startupFailedAt = observation?.startup_failed_at ? new Date(observation.startup_failed_at).toISOString() : undefined;
        offered.push({ ...candidate, workspaceReferences, models, modelCatalog, ...parameterObservation,
          ...(startupFailedAt ? { startupFailedAt } : {}),
          ...(responseLatency.has(candidate.key.harness) ? { responseLatencyMs: responseLatency.get(candidate.key.harness)! } : {}),
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
          supportsRequestedEffort: daemonCapable(daemon, "machine_routing_effort_v1"),
          supportsDefaultModelEffort: daemonCapable(daemon, "machine_routing_effort_v1") &&
            daemonCapable(daemon, "registration_default_effort_v1"), workspaces: [...workspaceReferences.flatMap(reference => {
            const repo = reference.startsWith("repo:") ? reference.slice(5) : undefined;
            return repo && repoSummonReference(repo) === repo ? [{ reference, repo,
              description: repositoryCatalog?.descriptions?.[repo] || "Authorized registered repository",
              machineId: candidate.key.machineId }] : [];
          }), ...directories.map(row => ({ reference: row.workspace_id,
          canonicalCwd: row.canonical_cwd, machineId: candidate.key.machineId,
          description: typeof row.metadata_json?.displayName === "string"
            ? row.metadata_json.displayName.slice(0, 500) : "Registered workspace" }))] });
        if (!online.length) waiting.add(offered.at(-1)!);
      }
      // A machine that is online starts the work now; one still reconnecting
      // is offered only when no other can take it.
      const ready = offered.filter(candidate => !waiting.has(candidate));
      if (ready.length && ready.length < offered.length) {
        for (const candidate of offered) if (waiting.has(candidate)) blocked.push({ machineId: candidate.key.machineId,
          ...(candidate.machineName ? { machineName: candidate.machineName } : {}), reason: "daemon_offline" });
        offered.splice(0, offered.length, ...ready);
      }
      return { offered, blocked, offlineOnly: offered.length === 0 && blocked.length > 0 && !droppedOther &&
        blocked.every(block => block.reason === "daemon_offline") };
    });
  }

}

function daemonCapable(row: QueryResultRow, capability: string): boolean {
  return Array.isArray(row.capabilities_json) && row.capabilities_json.includes(capability);
}

/** The machine's own report of this harness when it is older than the oldest
 * version its preset can be launched as: what is too old, where, and the
 * preset's update for that machine's platform. */
export function harnessTooOldOn(daemon: QueryResultRow, harness: string): HarnessTooOld | undefined {
  const metadata = daemon.metadata_json && typeof daemon.metadata_json === "object" ? daemon.metadata_json as Record<string, unknown> : undefined;
  const item = parseHarnessInventory(metadata?.harnesses)?.items.find(entry => entry.id === harness && entry.installed);
  const management = agentPresetById(harness)?.management;
  const tooOld = harnessTooOld(management, item?.version);
  if (!tooOld) return undefined;
  const machineName = typeof daemon.machine_name === "string" ? daemon.machine_name.trim() : "";
  const platform = metadata?.platform === "windows" || metadata?.platform === "win32" ? "windows"
    : ["macos", "darwin", "linux"].includes(String(metadata?.platform)) ? "unix" : undefined;
  const update = platform ? management?.update[platform] : undefined;
  return { ...tooOld, ...(machineName ? { machineName } : {}), ...(update ? { update: harnessCommandLine(update) } : {}) };
}

/** This harness signed out of its account on its machine: which program on
 * which machine. The machine's own report says so, or a start or turn it
 * refused as signed out (`signedOutAt`) that neither a later report nor a
 * later message from one of its Instances has answered: a program's status
 * command can say signed in while its token cannot refresh, and one process
 * refused by its provider (a token another process just rotated) is not the
 * program signed out once an Instance of it speaks again. Hub's turn-failure
 * notice in the Instance's name (`turn-failure:` id) is not it speaking.
 * An unchecked or unknown sign-in is not judged. */
export function harnessSignedOutOn(daemon: QueryResultRow, key: { harness: string; machineId: string },
  signedOutAt?: unknown): HarnessSignedOut | undefined {
  const metadata = daemon.metadata_json && typeof daemon.metadata_json === "object" ? daemon.metadata_json as Record<string, unknown> : undefined;
  const inventory = parseHarnessInventory(metadata?.harnesses);
  const item = inventory?.items.find(entry => entry.id === key.harness && entry.installed);
  const refusedAt = signedOutAt instanceof Date ? signedOutAt.getTime()
    : typeof signedOutAt === "string" ? Date.parse(signedOutAt) : Number.NaN;
  const unanswered = Number.isFinite(refusedAt) && !(inventory && Date.parse(inventory.capturedAt) > refusedAt);
  if (item?.login !== "signed_out" && !unanswered) return undefined;
  const machineName = typeof daemon.machine_name === "string" ? daemon.machine_name.trim() : "";
  return { harness: key.harness, program: agentPresetById(key.harness)?.displayName ?? key.harness,
    machineId: key.machineId, ...(machineName ? { machineName } : {}) };
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
