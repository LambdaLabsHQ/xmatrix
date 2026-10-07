import { storedObject as object } from "./stored-values.js";
import { RegistrationPreparationAuthority } from "./registration-preparation-authority.js";
import { hostnameMetadata } from "./hostname-metadata.js";
import { canonicalRegistrationHarness, digestCanonicalCloneCborV1, parseAgentRegistrationEnvironment, parseRegistrationResourceLimits,
  parseSpaceAgentConfiguration, registrationLaunchBindingForDaemon, TERMINAL_RUN_STATUS_SQL, type RegistrationLaunchBinding, type RegistrationResourceLimits,
  type SpaceAgentRegistrationKey, hasControlCharacter,
} from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { RegistrationAccessError, registrationRouteRefusal } from "./agent-registration-errors.js";
import { registrationInstructionsSpawnFields } from "./registration-instructions-spawn.js";
import { spaceRulesSpawnFields } from "./space-rules-spawn.js";
import { requireRegistrationAdmission } from "./agent-registration-access.js";
import { REGISTRATION_KEY_SQL, registrationKeyValues } from "./agent-registration-rows.js";
import { PostgresRegistrationExecutionRepository } from "./agent-registration-execution.js";
import { registrationLaunchSpawnFields } from "./agent-registration-launch.js";
import { commitRuntime, expireInstanceTraceAccess, runtimeChannelCapability } from "./runtime-control.js";
import { prepareReborn, prepareHandoff, advanceReborn } from "./runtime-reborn.js";
import { naturalInstanceOrdinal, reserveNaturalKey } from "./natural-keys.js";
import { readContinuationSource } from "./runtime-continuation-source.js";
import { currentRegistrationQuotaJoin, recordRegistrationUsageLimit, REGISTRATION_QUOTA_POOL_SQL,
  registrationQuotaReading } from "./agent-registration-quota-probe.js";

interface RebornRegistration {
  key: SpaceAgentRegistrationKey; actorUserId: string; requested: RegistrationResourceLimits;
  authorizationDigest: string; grantRevision: number; grantExecutionRevision: number;
  policyRevision: number; policyExecutionRevision: number; model: string;
}

/**
 * The pool slot a repo-launched predecessor ran in, as its daemon reported it.
 * A reborn must lease exactly this slot back: the harness session is keyed by
 * that directory, so any other cwd cannot resume it. `undefined` means the
 * predecessor never ran from the pool; a malformed record is refused rather
 * than silently dropped, because dropping it is what sends the daemon to cut a
 * fresh tree the harness then refuses.
 */
function retainedRepoPool(metadata: Record<string, unknown>) {
  if (metadata.repoPool === undefined) return undefined;
  const value = object(metadata.repoPool);
  const { repoIdentity, repoKeyId, slotId } = value;
  if (Object.keys(value).some(key => !["repoIdentity", "repoKeyId", "slotId"].includes(key)) ||
      typeof repoIdentity !== "string" || !repoIdentity.trim() || repoIdentity.length > 1_000 ||
      hasControlCharacter(repoIdentity) ||
      typeof repoKeyId !== "string" || !/^[0-9a-f]{64}$/u.test(repoKeyId) ||
      typeof slotId !== "string" || !/^[0-9a-f]{32}$/u.test(slotId)) {
    throw new RegistrationAccessError("registration_reborn_repo_pool_invalid", 409);
  }
  return { repoIdentity: repoIdentity.trim(), repoKeyId, slotId };
}

function text(value: unknown, code = "invalid_registration_reborn"): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 300) {
    throw new RegistrationAccessError(code, 400);
  }
  return value;
}

type ContinuationInput = ReturnType<typeof continuationInput>;

function continuationInput(raw: { commandId: string; actorUserId: string; channelId: string; sourceMessageId: string;
  sourceInstanceId: string; sourceMention?: string; prompt: string }) {
  return { commandId: text(raw.commandId), actorUserId: text(raw.actorUserId), channelId: text(raw.channelId),
    sourceMessageId: text(raw.sourceMessageId), sourceInstanceId: text(raw.sourceInstanceId),
    sourceMention: typeof raw.sourceMention === "string" ? raw.sourceMention : undefined,
    prompt: typeof raw.prompt === "string" ? raw.prompt.slice(0, 64 * 1024) : "" };
}

/** A wake refusal that no later message can change: the Instance stops resting.
 * `registration_daemon_offline` is deliberately absent: the daemon reconnects. */
const PERMANENT_WAKE_REFUSALS = new Set(["instance_not_found", "registration_not_found",
  "registration_reborn_unregistered", "registration_reborn_not_registered", "registration_environment_missing",
  "registration_reborn_repo_pool_invalid", "reborn_source_fenced",
  "handoff_source_transferred", "forbidden"]);

/** A resting Instance whose wake failed stays in its Channel as `wake_failed`
 * with the reason (`$2`); nothing but an explicit `:reborn` resumes it. */
export const WAKE_FAILED_SQL = `UPDATE data.instances SET rest_state='wake_failed',rest_reason=$2,
  version=version+1,updated_at=GREATEST(updated_at,$3::timestamptz) WHERE instance_id=$1 AND channel_id=$4
  AND status='offline' AND rest_state IN ('sleeping','interrupted') RETURNING instance_id`;

/** Registrations one `handoff:@auto` reads, and successors it tries. */
const USAGE_LIMIT_SUCCESSOR_CANDIDATES = 32;
const USAGE_LIMIT_SUCCESSOR_ATTEMPTS = 4;

/** Successor harnesses in the order `handoff:@auto` tries them: never
 * one drawing on the exhausted pool or one whose own pool reads empty; most
 * headroom first, an unmeasured pool counting as full the way launch routing
 * assumes it, then by name so the choice is stable. */
export function autoHandoffSuccessorOrder(candidates: ReadonlyArray<{ harness: string; sharesSourcePool: boolean;
  remainingPercent?: number }>): string[] {
  return candidates
    .filter(candidate => !candidate.sharesSourcePool && (candidate.remainingPercent ?? 1) > 0)
    .sort((a, b) => (b.remainingPercent ?? 100) - (a.remainingPercent ?? 100) || a.harness.localeCompare(b.harness))
    .map(candidate => candidate.harness);
}

/** Resting Instances one message may wake (docs/instance-sleep.md §3). */
export const MAX_WAKES_PER_MESSAGE = 16;

/** Fence a handed-off predecessor. `$3` is both the recorded text and the row's
 * timestamp: it is typed once as text, so `updated_at` casts it explicitly, or
 * Postgres refuses every handoff with 42804. */
export const HANDOFF_SOURCE_FENCE_SQL = `UPDATE data.runs r SET
  metadata_json=r.metadata_json||jsonb_build_object('instanceHandoff',jsonb_build_object('schemaVersion',1,
    'instanceId',i.instance_id,'runId',r.run_id,'successorInstanceId',$1::text,'sourceMessageId',$2::text,
    'reason','Handoff','transferredAt',$3::text)),version=r.version+1,updated_at=$3::timestamptz
  FROM data.instances i WHERE i.instance_id=$4 AND i.channel_id=$5 AND r.run_id=i.run_id
    AND NOT r.metadata_json ? 'instanceHandoff' AND NOT r.metadata_json ? 'instanceDeletion'
  RETURNING r.run_id`;

type ContinuationPhysical = { workspace?: QueryResultRow };
type ContinuationSource = { remoteRepo?: string; hostname?: string; hostId?: string; canonicalCwd?: string; managedWorkspaceKey?: string;
  repoPool?: Record<string, string> };

/** The directory the successor is admitted to: the predecessor's repository or registered Workspace. */
function workspaceReference(source: ContinuationSource, physical: ContinuationPhysical): string {
  return source.remoteRepo ? `repo:${source.remoteRepo}` : String(physical.workspace!.workspace_id);
}

function continuationHost(source: ContinuationSource, physical: ContinuationPhysical): string {
  // The physical query has already established the exact owner + Machine route.
  // Observation availability is independent of continuation authorization.
  const observation = source.hostname ?? source.hostId ?? physical.workspace?.hostname;
  return typeof observation === "string" ? observation : "";
}

/** The successor's admission under its registration, fenced to the grant and
 * policy revisions it was decided against. */
async function admitContinuation(tx: DatabaseTransaction, input: ContinuationInput, key: SpaceAgentRegistrationKey,
  requested: RegistrationResourceLimits, model: string): Promise<RebornRegistration> {
  const decision = await requireRegistrationAdmission(tx, { key, actorUserId: input.actorUserId,
    channelId: input.channelId, requested });
  const authorizationDigest = await digestCanonicalCloneCborV1({ key, actorUserId: input.actorUserId,
    channelId: input.channelId, sourceMessageId: input.sourceMessageId, sourceInstanceId: input.sourceInstanceId,
    requested, fence: decision.fence });
  return { key, actorUserId: input.actorUserId, requested, authorizationDigest,
    grantRevision: decision.fence.grantRevision, grantExecutionRevision: decision.fence.grantExecutionRevision,
    policyRevision: decision.fence.policyRevision, policyExecutionRevision: decision.fence.policyExecutionRevision, model };
}

/** Where the successor runs: the predecessor's retained repository slot (its
 * harness session only resumes in that exact directory) or its Workspace. */
function continuationSpawnWorkspace(source: ContinuationSource, key: SpaceAgentRegistrationKey, hostId: string,
  physical: ContinuationPhysical, at: string) {
  return {
    ...(source.remoteRepo ? { remoteRepo: source.remoteRepo, runWorktree: true } : {}),
    ...(source.remoteRepo && source.repoPool ? source.repoPool : {}),
    workspace: source.remoteRepo
      ? { managedKey: source.managedWorkspaceKey, ownerUserId: key.ownerUserId, machineId: key.machineId, hostname: hostId || undefined, hostId,
        canonicalCwd: `.xmatrix-management/${source.managedWorkspaceKey}`, displayName: source.remoteRepo,
        visibility: "private", createdAt: at, updatedAt: at, lastSeenAt: at }
      : { ownerUserId: key.ownerUserId, machineId: key.machineId, hostname: hostId || undefined, hostId, canonicalCwd: source.canonicalCwd,
        displayName: String(object(physical.workspace!.metadata_json).displayName ?? "Workspace"),
        visibility: "private", createdAt: at, updatedAt: at, lastSeenAt: at },
  };
}

/**
 * Continuations of a registration Run, both through one durable intent (stop
 * the predecessor, then create its successor):
 * - reborn: the predecessor Instance keeps its id, Channel slot and harness
 *   session; the successor is a Run of the predecessor's own registration.
 * - handoff: a new Instance of another harness registered on the same owner's
 *   machine takes over the predecessor's retained directory.
 */
export class PostgresRegistrationRebornRepository extends RegistrationPreparationAuthority {

  /** An explicit `@name:N:reborn`: stop the Instance, then resume it, answering the message that asked. */
  async prepare(raw: { commandId: string; actorUserId: string; channelId: string; sourceMessageId: string;
    sourceInstanceId: string; sourceMention?: string; prompt: string }) {
    return this.recordResume(continuationInput(raw), "reborn");
  }

  /**
   * One durable resume of an Instance in its own session and directory, recorded
   * as `kind`. A reborn names its asking message as its continuation source, so
   * its status and failure answer that message; a wake answers no message.
   */
  private async recordResume(input: ContinuationInput, kind: "reborn" | "wake") {
    const spaceId = this.placement.spaceId;
    const located = await this.locate(input, "reborn");
    const physical = await this.physical(input, located.key, located, "reborn", located.useRuntimeDefaultModel === true);
    const at = new Date().toISOString();
    return this.database.transaction({ requestId: input.commandId, operation: `registration.${kind}.prepare`,
      placement: this.placement }, async tx => {
      const { source, successor } = await this.resumeSuccessor(tx, input, located, physical, at);
      // The written mention binds this reborn's status to its source message.
      const invocationSource = kind === "reborn" ? readContinuationSource({ schemaVersion: 1, kind: "reborn",
        sourceMessageId: input.sourceMessageId, sourceMessageVersion: 1, sourceMention: input.sourceMention,
        sourceInstanceId: input.sourceInstanceId, sourceRunId: source.runId,
        sourceName: /^[@＠](.+):[1-9]\d*:reborn$/iu.exec(input.sourceMention ?? "")?.[1],
        sourceOrdinal: source.channelInstanceId, targetInstanceId: input.sourceInstanceId }) : undefined;
      const run = { ...successor.run, ...(invocationSource ? { invocationSource } : {}) };
      const value = await prepareReborn(tx, { kind, run, instance: successor.instance, spawnPayload: successor.spawn,
        channelId: input.channelId, sourceRunId: source.runId, sourceInstanceId: input.sourceInstanceId },
      input.actorUserId, spaceId, at);
      if (value.reused !== true) {
        await commitRuntime(tx, spaceId, { commandId: input.commandId, kind: `${kind}_prepare`, reused: false, ...value }, at);
      }
      return value;
    });
  }

  /** The successor Run, Instance rebind and spawn that resume a source Instance
   * under its own registration, re-admitted against current grants. */
  private async resumeSuccessor(tx: DatabaseTransaction, input: ContinuationInput,
    located: Awaited<ReturnType<PostgresRegistrationRebornRepository["locate"]>>,
    physical: Awaited<ReturnType<PostgresRegistrationRebornRepository["physical"]>>, at: string) {
    const spaceId = this.placement.spaceId;
    const key = located.key;
    const { source, displayName } = await this.lockedSource(tx, input, key, located.key, "reborn");
    const model = source.useRuntimeDefaultModel ? "" : source.requestedRuntimeModel ?? "";
    const modelResource = model ? source.modelResource ?? model : undefined;
    const requested = parseRegistrationResourceLimits({ workspaces: [workspaceReference(source, physical)],
      models: modelResource ? [modelResource] : [], capabilities: [] });
    const suffix = (await digestCanonicalCloneCborV1(["reborn", input.sourceMessageId, input.sourceInstanceId])).slice(0, 64);
    // The successor is the next Run of the predecessor's Instance, reserved
    // under the resume key so a replay receives the same Run.
    const runId = (await reserveNaturalKey(tx, { creationKey: `run:reborn:${suffix}`, channelId: input.channelId,
      scope: "run", channelInstanceId: Number(source.channelInstanceId), at: new Date().toISOString() })).runId;
    const executionKey = `exec:reborn:${suffix}`;
    const registration = await admitContinuation(tx, input, key, requested, model);
    const launch = physical.environment.launch;
    // Preserve a hostname observation independently of the execution target.
    const hostId = continuationHost(source, physical);
    const runMetadata = { machineId: key.machineId, hostname: hostId || undefined, hostId, executionKey, resumeSessionKey: source.resumeSessionKey,
      spawnControlId: `reborn:1-spawn:${suffix}`, resumeInstanceId: input.sourceInstanceId, identityKind: "instance",
      agentName: displayName, summonedByUserId: input.actorUserId,
      sourceMessageId: input.sourceMessageId, useRuntimeDefaultModel: !model, requestedRuntimeModel: model || null, modelResource: modelResource ?? null,
      ...(source.managedWorkspaceKey ? { managedWorkspaceKey: source.managedWorkspaceKey } : {}),
      ...(source.remoteRepo ? { remoteRepo: source.remoteRepo, runWorktree: true } : {}) };
    // The successor records the predecessor's Workspace columns verbatim. A
    // registered repo launch records its managed key as its cwd; only a Run
    // that recorded none (a legacy repo summon) keeps the managed-key binding.
    const workspace = source.canonicalCwd ? { machineId: key.machineId, canonicalCwd: source.canonicalCwd } : undefined;
    // A registered successor has no Profile, so its Instance is the actor.
    const run: Record<string, unknown> = { runId, channelId: input.channelId, status: "starting", spaceId,
      metadata: runMetadata, ...(workspace ? { workspace } : {}), registration };
    const instance = { instanceId: input.sourceInstanceId, runId, channelId: input.channelId, status: "offline",
      channelInstanceId: source.channelInstanceId, spaceId };
    const spawn = { type: "machine_spawn_agent", requestId: `reborn:1-spawn:${suffix}`, spaceId, channelId: input.channelId,
      runId, instanceId: input.sourceInstanceId, executionKey, identityId: input.sourceInstanceId,
      resumeInstanceId: input.sourceInstanceId, resume: true, resumeSessionKey: source.resumeSessionKey,
      ...registrationLaunchSpawnFields(launch, key.harness),
      // The resumed Instance takes its source message as its first prompt: join
      // catch-up alone cannot deliver it to an Instance that never acknowledged
      // a delivery (a floor of 0 replays nothing), and when it does replay it
      // the initial message id drops the copy as a summon echo.
      agentName: displayName, prompt: input.prompt, sourceMessageId: input.sourceMessageId,
      resumeWorktreeBootstrap: true,
      context: model ? { requestedModel: model } : {},
      ...continuationSpawnWorkspace(source, key, hostId, physical, at) };
    return { source, successor: { run, instance, spawn } };
  }

  /**
   * Wake the Channel's resting Instances for one committed message, exactly as
   * that message would have reached them live (docs/instance-sleep.md §3). Each
   * wake resumes the Instance as its owner, as a `wake` continuation: it answers
   * no message and stops nothing. An Instance that is already waking is skipped;
   * one whose wake can never succeed is left `wake_failed` with its reason, so
   * its Channel sees why and later messages do not keep retrying it.
   */
  async wakeResting(raw: { commandId: string; channelId: string; sourceMessageId: string; prompt?: string }) {
    const channelId = text(raw.channelId), sourceMessageId = text(raw.sourceMessageId);
    const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
    const commandId = text(raw.commandId);
    const candidates = await this.database.transaction({ requestId: commandId, operation: "registration.wake.candidates",
      placement: this.placement }, tx => tx.query({ name: "registration_wake_resting_candidates_v1", text: `SELECT
        i.instance_id,r.owner_user_id FROM data.instances i
        JOIN data.runs r ON r.run_id=i.run_id AND r.channel_id=i.channel_id
        WHERE i.channel_id=$1 AND i.status='offline' AND i.rest_state IN ('sleeping','interrupted')
          AND r.status IN (${TERMINAL_RUN_STATUS_SQL})
          AND NOT EXISTS (SELECT 1 FROM data.agent_reborn_intents intent
            WHERE intent.source_instance_id=i.instance_id AND intent.state IN ('waiting','prepared'))
        ORDER BY i.updated_at DESC,i.instance_id LIMIT 16`,
      values: [channelId], maxRows: MAX_WAKES_PER_MESSAGE }));
    const woken: Array<{ instanceId: string; intentId: string; state: string }> = [];
    const refused: Array<{ instanceId: string; code: string; permanent: boolean }> = [];
    for (const candidate of candidates) {
      const instanceId = String(candidate.instance_id);
      try {
        const value = await this.recordResume(continuationInput({
          commandId: `instance-wake:${sourceMessageId}:${instanceId}`.slice(0, 200),
          actorUserId: String(candidate.owner_user_id), channelId, sourceMessageId, sourceInstanceId: instanceId,
          prompt }), "wake");
        woken.push({ instanceId, intentId: String(value.intentId), state: String(value.state) });
      } catch (error) {
        const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code : "registration_reborn_failed";
        const status = error && typeof error === "object" ? Number((error as { status?: unknown }).status) : NaN;
        // A concurrent message already started this Instance's wake.
        if (code === "reborn_pending") continue;
        const permanent = PERMANENT_WAKE_REFUSALS.has(code) || status === 404;
        refused.push({ instanceId, code, permanent });
        if (permanent) await this.database.transaction({ requestId: `${commandId}:rest:${instanceId}`.slice(0, 200),
          operation: "registration.wake.retire", placement: this.placement }, tx => tx.query({
          name: "registration_wake_resting_fail_v1", text: WAKE_FAILED_SQL,
          values: [instanceId, code, new Date().toISOString(), channelId], maxRows: 1 }));
      }
    }
    return { woken, refused };
  }

  /** Hand a predecessor's retained directory to a new Instance of another
   * harness registered on the same owner's machine. */
  async prepareHandoff(raw: { commandId: string; actorUserId: string; channelId: string; sourceMessageId: string;
    sourceInstanceId: string; sourceMention?: string; successorHarness: string; prompt: string }) {
    const input = continuationInput(raw);
    let successorHarness: string;
    try { successorHarness = canonicalRegistrationHarness(raw.successorHarness); } catch {
      throw new RegistrationAccessError("invalid_registration_handoff", 400);
    }
    const spaceId = this.placement.spaceId;
    const located = await this.locate(input, "handoff");
    if (located.handedOff) {
      const own = await this.messageHandoff(input);
      if (own) return own;
      throw new RegistrationAccessError("handoff_source_transferred", 409);
    }
    if (successorHarness === canonicalRegistrationHarness(located.key.harness)) {
      throw new RegistrationAccessError("handoff_same_agent", 409);
    }
    // Management and direct-conversation directories belong to their purpose.
    if (located.routedAs?.startsWith("management_") || located.routedAs === "direct_conversation") {
      throw new RegistrationAccessError("handoff_source_not_transferable", 409);
    }
    const key = { ...located.key, harness: successorHarness };
    // The successor starts on its runtime's default model: the predecessor's
    // model belongs to another harness.
    const physical = await this.physical(input, key, located, "handoff", true);
    const at = new Date().toISOString();
    return this.database.transaction({ requestId: input.commandId, operation: "registration.handoff.prepare",
      placement: this.placement }, async tx => {
      const { source, displayName, configuration } = await this.lockedSource(tx, input, key, located.key, "handoff");
      if (source.handedOff) throw new RegistrationAccessError("reborn_source_changed", 409);
      const requested = parseRegistrationResourceLimits({ workspaces: [workspaceReference(source, physical)], models: [],
        capabilities: [] });
      const suffix = (await digestCanonicalCloneCborV1(["handoff", input.sourceMessageId, input.sourceInstanceId,
        key.harness])).slice(0, 64);
      const reserved = await reserveNaturalKey(tx, { creationKey: `handoff:${suffix}`, channelId: input.channelId,
        scope: "instance", at });
      const runId = reserved.runId, instanceId = String(reserved.instanceId);
      const channelInstanceId = naturalInstanceOrdinal(input.channelId, instanceId);
      if (channelInstanceId === null) throw new RegistrationAccessError("registration_handoff_instance_unavailable", 409);
      const executionKey = `exec:handoff:${suffix}`;
      const registration = await admitContinuation(tx, input, key, requested, "");
      const hostId = continuationHost(source, physical);
      const resumeSessionKey = `resume:${key.ownerUserId}:${input.channelId}:${instanceId}`;
      const runMetadata = { machineId: key.machineId, hostname: hostId || undefined, hostId, executionKey, resumeSessionKey,
        spawnControlId: `handoff:1-spawn:${suffix}`, identityKind: "instance", agentName: displayName,
        summonedByUserId: input.actorUserId,
        sourceMessageId: input.sourceMessageId,
        useRuntimeDefaultModel: true, requestedRuntimeModel: null, modelResource: null,
        routedAs: "agent_mention_handoff", handoffTransfer: true, handoffSourceInstanceId: input.sourceInstanceId,
        ...(source.managedWorkspaceKey ? { managedWorkspaceKey: source.managedWorkspaceKey } : {}),
        ...(source.remoteRepo ? { remoteRepo: source.remoteRepo, runWorktree: true } : {}) };
      const workspace = source.canonicalCwd ? { machineId: key.machineId, canonicalCwd: source.canonicalCwd } : undefined;
      const invocationSource = readContinuationSource({ schemaVersion: 1, kind: "handoff",
        sourceMessageId: input.sourceMessageId, sourceMessageVersion: 1, sourceMention: input.sourceMention,
        sourceInstanceId: input.sourceInstanceId, sourceRunId: source.runId,
        sourceName: source.agentName, sourceOrdinal: source.channelInstanceId, targetInstanceId: instanceId });
      const run = { runId, channelId: input.channelId, status: "starting", spaceId, handoff: true,
        metadata: runMetadata, ...(workspace ? { workspace } : {}), registration,
        ...(invocationSource ? { invocationSource } : {}) };
      const instance = { instanceId, runId, channelId: input.channelId, status: "offline", channelInstanceId, spaceId };
      const spaceRules = await spaceRulesSpawnFields(tx, spaceId);
      const spawn = { type: "machine_spawn_agent", requestId: `handoff:1-spawn:${suffix}`, spaceId, channelId: input.channelId,
        runId, instanceId, executionKey, identityId: instanceId, resumeSessionKey,
        handoffTransfer: true, handoffSourceInstanceId: input.sourceInstanceId,
        ...(source.resumeSessionKey ? { handoffSourceResumeSessionKey: source.resumeSessionKey } : {}),
        ...registrationLaunchSpawnFields(physical.environment.launch, key.harness),
        agentName: displayName, prompt: input.prompt, sourceMessageId: input.sourceMessageId, context: {},
        ...registrationInstructionsSpawnFields(configuration), ...spaceRules,
        ...continuationSpawnWorkspace(source, key, hostId, physical, at) };
      const value = await prepareHandoff(tx, { run, instance, spawnPayload: spawn, channelId: input.channelId,
        sourceRunId: source.runId, sourceInstanceId: input.sourceInstanceId }, input.actorUserId, spaceId, at);
      if (value.reused !== true) {
        await commitRuntime(tx, spaceId, { commandId: input.commandId, kind: "handoff_prepare", reused: false, ...value }, at);
      }
      return value;
    });
  }

  /** A live Instance reported its provider account's usage limit used up:
   * hold its quota pool empty until the reset, so no routing picks it again.
   * Moving its work is an ordinary `handoff:@auto` the Hub posts next. Only
   * the Instance's owner, acting through that Instance's own Run, gets here. */
  async holdUsageLimit(raw: { commandId: string; actorUserId: string; channelId: string; sourceInstanceId: string;
    resetsAt?: string }): Promise<{ limitedUntil?: string }> {
    const input = continuationInput({ ...raw, sourceMessageId: raw.commandId, prompt: "" });
    const located = await this.locate(input, "handoff");
    if (located.key.ownerUserId !== input.actorUserId) throw new RegistrationAccessError("forbidden", 403);
    const held = await this.directory.transaction({ requestId: `${input.commandId}:limit`,
      operation: "registration.usage-limit.record" }, tx => recordRegistrationUsageLimit(tx, {
      ownerUserId: located.key.ownerUserId, machineId: located.key.machineId, harness: located.key.harness,
      ...(raw.resetsAt ? { resetsAt: raw.resetsAt } : {}) }));
    return held?.limitedUntil ? { limitedUntil: held.limitedUntil } : {};
  }

  /** `handoff:@auto`: hand the retained directory to the first other harness
   * the same owner registered on the same machine whose account still has
   * headroom. With nobody there, a repository-backed source names its
   * repository so the Hub can start a successor on any machine. */
  async prepareAutoHandoff(raw: { commandId: string; actorUserId: string; channelId: string;
    sourceMessageId: string; sourceInstanceId: string; sourceMention?: string; prompt: string }) {
    const input = continuationInput(raw);
    const located = await this.locate(input, "handoff");
    if (located.handedOff) {
      const own = await this.messageHandoff(input);
      return own ? { outcome: "handed_off" as const, intentId: own.intentId, state: own.state, refusals: [] }
        : { outcome: "source_transferred" as const, refusals: [] };
    }
    if (located.routedAs?.startsWith("management_") || located.routedAs === "direct_conversation") {
      return { outcome: "not_transferable" as const, refusals: [] };
    }
    const refusals: Array<{ harness: string; code: string }> = [];
    for (const harness of await this.autoHandoffSuccessors(input, located.key)) {
      try {
        const value = await this.prepareHandoff({ ...raw, commandId: `${input.commandId}:${harness}`.slice(0, 200),
          successorHarness: harness });
        return { outcome: "handed_off" as const, successorHarness: harness, intentId: String(value.intentId),
          state: String(value.state), refusals };
      } catch (error) {
        if (!(error instanceof RegistrationAccessError)) throw error;
        // This message's own handoff is already under way, possibly to a
        // successor tried earlier while quotas read differently.
        if (error.code === "reborn_pending") {
          const own = await this.messageHandoff(input);
          if (own) return { outcome: "handed_off" as const, intentId: own.intentId, state: own.state, refusals };
        }
        // The source changed under us; no other successor can take it either.
        if (["handoff_source_transferred", "reborn_source_changed", "reborn_pending", "instance_not_found",
          "forbidden"].includes(error.code)) {
          return { outcome: "refused" as const, code: error.code, refusals };
        }
        refusals.push({ harness, code: error.code });
      }
    }
    return { outcome: "no_successor" as const, refusals,
      ...(located.remoteRepo ? { repository: located.remoteRepo } : {}) };
  }

  /** Other harnesses the owner registered in this Space on the source's
   * machine, routable and with headroom on a pool other than the source's,
   * in [autoHandoffSuccessorOrder]. */
  private async autoHandoffSuccessors(input: ContinuationInput, key: SpaceAgentRegistrationKey): Promise<string[]> {
    const registrations = await this.database.transaction({ requestId: `${input.commandId}:successors`,
      operation: "registration.usage-limit.successors", placement: this.placement }, tx => tx.query({
      name: "registration_usage_limit_successors_v1", text: `SELECT r.harness,r.configuration_json
        FROM data.space_agent_registrations r
        JOIN data.space_agent_registration_access a ON a.space_id=r.space_id AND a.owner_user_id=r.owner_user_id
          AND a.machine_id=r.machine_id AND a.harness=r.harness
        WHERE r.space_id=$1 AND r.owner_user_id=$2 AND r.machine_id=$3 AND r.harness<>$4
          AND a.grant_state='active' AND a.policy_state='enabled'
        ORDER BY r.harness LIMIT ${USAGE_LIMIT_SUCCESSOR_CANDIDATES}`,
      values: [key.spaceId, key.ownerUserId, key.machineId, key.harness], maxRows: USAGE_LIMIT_SUCCESSOR_CANDIDATES }));
    const harnesses = registrations
      .filter(row => parseSpaceAgentConfiguration(row.configuration_json).routing?.enabled !== false)
      .map(row => String(row.harness));
    if (!harnesses.length) return [];
    const facts = await this.directory.transaction({ requestId: `${input.commandId}:successor-quota`,
      operation: "registration.usage-limit.successor-quota" }, tx => tx.query({
      name: "registration_usage_limit_successor_quota_v1", text: `SELECT e.harness,e.declaration_json,
        statement_timestamp() AS evaluated_at,${REGISTRATION_QUOTA_POOL_SQL} AS quota_pool_id,
        (SELECT ${REGISTRATION_QUOTA_POOL_SQL} FROM control.agent_registration_environments e
          WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=$4) AS source_pool_id,
        q.remaining,q.observed_at,q.expires_at
        FROM control.agent_registration_environments e ${currentRegistrationQuotaJoin("q")}
        WHERE e.owner_user_id=$1 AND e.machine_id=$2 AND e.harness=ANY($3::text[])`,
      values: [key.ownerUserId, key.machineId, harnesses, key.harness], maxRows: USAGE_LIMIT_SUCCESSOR_CANDIDATES }));
    return autoHandoffSuccessorOrder(facts.flatMap(row => {
      let environment;
      try { environment = parseAgentRegistrationEnvironment(row.declaration_json); } catch { return []; }
      const evaluatedAt = new Date(row.evaluated_at as string).getTime();
      if (!environment.enabled || environment.availableUntil && Date.parse(environment.availableUntil) <= evaluatedAt) return [];
      return [{ harness: String(row.harness), sharesSourcePool: row.quota_pool_id === row.source_pool_id,
        remainingPercent: registrationQuotaReading(row)?.remainingPercent }];
    })).slice(0, USAGE_LIMIT_SUCCESSOR_ATTEMPTS);
  }

  /** The handoff this very message already started from this source. The
   * same message is interpreted again when its post is replayed or a usage
   * limit is reported again; it gets its own handoff back, not a refusal. */
  private async messageHandoff(input: ContinuationInput): Promise<{ entityId: string; intentId: string;
    state: string; reused: true } | undefined> {
    const row = (await this.database.transaction({ requestId: `${input.commandId}:own-handoff`,
      operation: "registration.handoff.replay", placement: this.placement }, tx => tx.query<QueryResultRow>({
      name: "registration_handoff_by_message_v1", text: `SELECT intent_id,state,instance_input_json
        FROM data.agent_reborn_intents WHERE source_instance_id=$1 AND channel_id=$2 AND state<>'failed'
          AND run_input_json->'handoff'='true'::jsonb AND run_input_json->'metadata'->>'sourceMessageId'=$3
        ORDER BY created_at DESC LIMIT 1`,
      values: [input.sourceInstanceId, input.channelId, input.sourceMessageId], maxRows: 1 })))[0];
    return row ? { entityId: String(object(row.instance_input_json).instanceId ?? ""), intentId: String(row.intent_id),
      state: String(row.state), reused: true } : undefined;
  }

  /** The predecessor's tuple and Workspace, read before the directory facts.
   * Its repository is passed on as is: GitHub decides whether it can be cloned. */
  private locate(input: ContinuationInput, operation: "reborn" | "handoff") {
    return this.database.transaction({ requestId: input.commandId, operation: `registration.${operation}.locate`,
      placement: this.placement }, tx => this.predecessor(tx, input.sourceInstanceId, input.channelId));
  }

  /** The successor tuple's machine environment and the predecessor's Workspace
   * row; both live in the directory, not in this Space's shard. */
  private physical(input: ContinuationInput, key: SpaceAgentRegistrationKey,
    located: { hostId?: string; remoteRepo?: string; canonicalCwd?: string }, operation: "reborn" | "handoff",
    runtimeDefaultModel: boolean) {
    return this.directory.transaction({ requestId: input.commandId, operation: `registration.${operation}.physical` },
      async tx => {
        if (runtimeDefaultModel) {
          const routes = await tx.query({ name: "registration_continuation_default_model_route_v2", text: `SELECT 1 FROM data.machine_daemons
            WHERE owner_user_id=$1 AND machine_id=$2 AND status='online'
              AND capabilities_json ? 'registration_optional_model_v1' LIMIT 1`,
            values: [key.ownerUserId, key.machineId], maxRows: 1 });
          if (!routes.length) throw await registrationRouteRefusal(tx, "registration_workspace_or_daemon_unavailable",
            { ...key, hostId: located.hostId });
        }
        const environments = await tx.query({ name: "registration_continuation_environment_v1", text: `SELECT declaration_json
          FROM control.agent_registration_environments WHERE owner_user_id=$1 AND machine_id=$2 AND harness=$3`,
        values: [key.ownerUserId, key.machineId, key.harness], maxRows: 1 });
        if (!environments[0]) throw new RegistrationAccessError("registration_environment_missing", 409);
        const workspaces = located.remoteRepo ? [] : await tx.query({ name: "registration_continuation_workspace_v3",
          text: `SELECT w.workspace_id,w.canonical_cwd,w.metadata_json,d.hostname FROM data.workspaces w
            JOIN data.machine_daemons d ON d.owner_user_id=w.owner_user_id AND d.machine_id=w.machine_id
            WHERE w.owner_user_id=$1 AND w.machine_id=$2 AND w.canonical_cwd=$3 LIMIT 2`,
          values: [key.ownerUserId, key.machineId, located.canonicalCwd], maxRows: 2 });
        const workspace = workspaces[0];
        if (!located.remoteRepo && workspaces.length !== 1) throw new RegistrationAccessError("registration_workspace_or_daemon_unavailable", 409);
        return { environment: parseAgentRegistrationEnvironment(environments[0].declaration_json), workspace };
      });
  }

  /** Under the Channel's Instance lock: the unchanged predecessor and the
   * successor registration's current name and configuration. */
  private async lockedSource(tx: DatabaseTransaction, input: ContinuationInput, key: SpaceAgentRegistrationKey,
    locatedKey: SpaceAgentRegistrationKey, operation: "reborn" | "handoff") {
    if ((await runtimeChannelCapability(tx, input.channelId, input.actorUserId, "runtime_new_work")).spaceId !== this.placement.spaceId) {
      throw new RegistrationAccessError("registration_placement_unavailable", 503);
    }
    await tx.query({ name: `registration_${operation}_channel_lock_v1`,
      text: "SELECT pg_advisory_xact_lock(hashtextextended('runtime-instance:'||$1,0))",
      values: [input.channelId], maxRows: 1 });
    const source = await this.predecessor(tx, input.sourceInstanceId, input.channelId);
    if (JSON.stringify(source.key) !== JSON.stringify(locatedKey)) throw new RegistrationAccessError("reborn_source_changed", 409);
    const rows = await tx.query({ name: "registration_continuation_configuration_v1", text: `SELECT display_name,
      configuration_json FROM data.space_agent_registrations
      WHERE ${REGISTRATION_KEY_SQL}`, values: registrationKeyValues(key), maxRows: 1 });
    if (!rows[0]) throw new RegistrationAccessError("registration_not_found", 404);
    return { source, displayName: String(rows[0].display_name),
      configuration: parseSpaceAgentConfiguration(rows[0].configuration_json) };
  }

  /** Advance a registered reborn intent once its predecessor stopped. The
   * allocation is reserved in the directory first; the Space transaction then
   * creates the registered successor and rebinds the Instance. Returns the
   * spawn payload carrying the complete registration binding. */
  async advance(input: { intentId: string; actorUserId: string; channelId: string }) {
    const intentId = text(input.intentId);
    const spaceId = this.placement.spaceId;
    const intent = (await this.database.transaction({ requestId: `reborn-read:${intentId}`, operation: "registration.reborn.read",
      placement: this.placement }, tx => tx.query({ name: "registration_reborn_intent_read_v1", text: `SELECT
        run_input_json,spawn_payload_json,state FROM data.agent_reborn_intents WHERE intent_id=$1 AND space_id=$2`,
      values: [intentId, spaceId], maxRows: 1 })))[0];
    if (!intent) throw new RegistrationAccessError("forbidden", 403);
    const registration = object(object(intent.run_input_json).registration) as unknown as RebornRegistration;
    if (!registration.key) throw new RegistrationAccessError("registration_reborn_not_registered", 409);
    if (intent.state !== "waiting") {
      return { entityId: intentId, state: String(intent.state), deferred: true, spawnPayload: intent.spawn_payload_json };
    }
    const allocation = await new PostgresRegistrationExecutionRepository(this.directory).reserve({
      requestId: `reborn-reserve:${intentId}`, key: registration.key, runId: intentId, sourceCommandId: intentId,
      actorUserId: registration.actorUserId, authorizationDigest: registration.authorizationDigest,
      requirements: { model: registration.model, unattended: false, requiredCapabilities: [], harness: registration.key.harness } });
    const at = new Date().toISOString();
    return this.database.transaction({ requestId: `reborn-advance:${intentId}`, operation: "registration.reborn.advance",
      placement: this.placement }, async tx => {
      let spawnPayload: Record<string, unknown> | undefined;
      const value = await advanceReborn(tx, { intentId, channelId: input.channelId }, input.actorUserId, spaceId, at,
        async (run, instance) => {
          const fence = { key: registration.key, grantRevision: registration.grantRevision,
            grantExecutionRevision: registration.grantExecutionRevision, policyRevision: registration.policyRevision,
            policyExecutionRevision: registration.policyExecutionRevision };
          await requireRegistrationAdmission(tx, { key: registration.key, actorUserId: registration.actorUserId,
            channelId: input.channelId, requested: registration.requested, fence });
          spawnPayload = await this.createSuccessor(tx, run, instance, registration, allocation, at);
        });
      return { ...value, ...(spawnPayload ? { spawnPayload } : {}) };
    });
  }

  private async createSuccessor(tx: DatabaseTransaction, run: Record<string, unknown>, instance: Record<string, unknown>,
    registration: RebornRegistration, allocation: { allocationId: string; environmentVersion: number; runtimeModel?: string },
    at: string): Promise<Record<string, unknown>> {
    const runId = text(run.runId), instanceId = text(instance.instanceId), channelId = text(run.channelId);
    const workspace = object(run.workspace);
    await tx.query({ name: "registration_reborn_run_v1", text: `INSERT INTO data.runs
      (run_id,owner_user_id,channel_id,workspace_machine_id,workspace_canonical_cwd,
       status,version,metadata_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'starting',1,$6::jsonb,$7,$7)`,
    values: [runId, registration.key.ownerUserId, channelId, workspace.machineId ?? null, workspace.canonicalCwd ?? null,
      JSON.stringify(hostnameMetadata(object(run.metadata))), at], maxRows: 0 });
    await tx.query({ name: "registration_reborn_run_binding_v1", text: `INSERT INTO data.run_agent_registrations
      (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
       grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    values: [runId, registration.key.spaceId, registration.key.ownerUserId, registration.key.machineId, registration.key.harness,
      registration.actorUserId, allocation.allocationId, registration.authorizationDigest, registration.grantRevision,
      registration.grantExecutionRevision, registration.policyRevision, registration.policyExecutionRevision,
      JSON.stringify(registration.requested)], maxRows: 0 });
    if (run.handoff === true) {
      // The predecessor stopped; its directory now belongs to a new Instance,
      // and the predecessor is fenced so nothing reborns or hands it off again.
      const sourceInstanceId = text(object(run.metadata).handoffSourceInstanceId);
      await tx.query({ name: "registration_handoff_instance_v1", text: `INSERT INTO data.instances
        (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'offline',1,$5,$5)`,
      values: [instanceId, runId, channelId, Number(instance.channelInstanceId), at], maxRows: 0 });
      const fenced = await tx.query({ name: "registration_handoff_source_fence_v2", text: HANDOFF_SOURCE_FENCE_SQL,
      values: [instanceId, object(run.metadata).sourceMessageId ?? null, at, sourceInstanceId, channelId], maxRows: 1 });
      if (!fenced[0]) throw new RegistrationAccessError("handoff_source_transferred", 409);
    } else {
      // The predecessor already stopped (the reborn intent waited for it), so the
      // Instance keeps its id and ordinal and moves to the successor Run.
      const rebound = await tx.query({ name: "registration_reborn_instance_rebind_v1", text: `UPDATE data.instances SET
        run_id=$1,status='offline',version=version+1,updated_at=$2 WHERE instance_id=$3 AND channel_id=$4
        RETURNING instance_id`, values: [runId, at, instanceId, channelId], maxRows: 1 });
      if (!rebound[0]) throw new RegistrationAccessError("reborn_source_changed", 409);
      await expireInstanceTraceAccess(tx, instanceId, at);
    }
    const binding: RegistrationLaunchBinding = { schemaVersion: 1, key: registration.key, runId, instanceId,
      allocationId: allocation.allocationId, authorizationDigest: registration.authorizationDigest,
      environmentVersion: allocation.environmentVersion, runtimeModel: allocation.runtimeModel, resources: registration.requested };
    const current = (await tx.query({ name: "registration_reborn_spawn_read_v1", text: `SELECT spawn_payload_json
      FROM data.agent_reborn_intents WHERE intent_id=$1`, values: [runId], maxRows: 1 }))[0];
    const spawnPayload = { ...object(current?.spawn_payload_json), registration: registrationLaunchBindingForDaemon(binding),
      context: { ...object(object(current?.spawn_payload_json).context),
        ...(typeof object(object(current?.spawn_payload_json).context).requestedModel === "string"
          ? { requestedModel: allocation.runtimeModel } : {}) } };
    await tx.query({ name: "registration_reborn_spawn_write_v1", text: `UPDATE data.agent_reborn_intents
      SET spawn_payload_json=$2::jsonb WHERE intent_id=$1`, values: [runId, JSON.stringify(spawnPayload)], maxRows: 0 });
    await commitRuntime(tx, registration.key.spaceId, { commandId: `reborn-create:${runId}`, kind: "registration_launch",
      entityId: runId, runId, instanceId, status: "starting" }, at);
    return spawnPayload;
  }

  /** The predecessor's registration tuple, Workspace and session. */
  private async predecessor(tx: DatabaseTransaction, instanceId: string, channelId: string) {
    const row = (await tx.query<QueryResultRow>({ name: "registration_reborn_predecessor_v2", text: `SELECT
        instance.run_id,instance.channel_instance_id,run.owner_user_id,run.metadata_json,
        run.workspace_canonical_cwd,binding.space_id AS b_space,binding.owner_user_id AS b_owner,
        binding.machine_id AS b_machine,binding.harness AS b_harness
      FROM data.instances instance JOIN data.runs run ON run.run_id=instance.run_id
      JOIN data.run_agent_registrations binding ON binding.run_id=run.run_id
      WHERE instance.instance_id=$1 AND instance.channel_id=$2 AND run.channel_id=instance.channel_id`,
    values: [instanceId, channelId], maxRows: 1 }))[0];
    if (!row) throw new RegistrationAccessError("instance_not_found", 404);
    const key = { spaceId: String(row.b_space), ownerUserId: String(row.b_owner),
      machineId: String(row.b_machine), harness: String(row.b_harness) };
    if (key.spaceId !== this.placement.spaceId) throw new RegistrationAccessError("registration_reborn_unregistered", 409);
    const metadata = object(row.metadata_json);
    const resumeSessionKey = typeof metadata.resumeSessionKey === "string" ? metadata.resumeSessionKey
      : `resume:${row.owner_user_id}:${channelId}:${instanceId}`;
    return { key, runId: String(row.run_id), channelInstanceId: Number(row.channel_instance_id), resumeSessionKey,
      canonicalCwd: row.workspace_canonical_cwd ? String(row.workspace_canonical_cwd) : undefined,
      useRuntimeDefaultModel: metadata.useRuntimeDefaultModel === true,
      requestedRuntimeModel: typeof metadata.requestedRuntimeModel === "string" ? metadata.requestedRuntimeModel : undefined,
      modelResource: typeof metadata.modelResource === "string" ? metadata.modelResource : undefined,
      hostname: typeof metadata.hostname === "string" ? metadata.hostname : undefined,
      hostId: typeof metadata.hostId === "string" ? metadata.hostId : undefined,
      managedWorkspaceKey: typeof metadata.managedWorkspaceKey === "string" ? metadata.managedWorkspaceKey : undefined,
      remoteRepo: typeof metadata.remoteRepo === "string" ? metadata.remoteRepo : undefined,
      routedAs: typeof metadata.routedAs === "string" ? metadata.routedAs : undefined,
      agentName: typeof metadata.agentName === "string" ? metadata.agentName : undefined,
      handedOff: metadata.instanceHandoff !== undefined || metadata.instanceDeletion !== undefined,
      repoPool: retainedRepoPool(metadata) };
  }
}
