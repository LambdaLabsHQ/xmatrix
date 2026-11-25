import { agentLaunchAccess, agentPresetById, harnessParameterObservation, machineResourceObservation, hasControlCharacter,
  routingModelOptionNamed } from "@xmatrix/protocol";
import { ACTIVE_RUN_STATUS_SQL, digestCanonicalCloneCborV1, parseSpaceAgentRegistrationKey, parseSpaceAgentConfiguration,
  registrationLimitsWithin, spaceConfigurationResources,
  parseRegistrationResourceLimits, intersectRegistrationLimits,
  parseAgentRegistrationEnvironment, parseStoredAgentRegistrationEnvironment, routingModelCatalogObservation,
  type AgentRegistrationEnvironment, type AgentRegistrationMachinePlatform, type AgentRegistrationRunningInstance, type AgentRegistrationSummary,
  type SpaceAgentRegistrationKey, type SpaceAgentConfiguration , utf8ByteLength,
  parseHarnessProfileCommand, type HarnessProfileCommand, type SpaceHarnessProfile } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabasePlacementContext } from "./context.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";
import { DatabaseContractError } from "./errors.js";
import { enrollGlobalRegistration } from "./agent-registration-enrollment.js";
import { currentRegistrationQuotaJoin, registrationLiveQuota, registrationQuotaAccount, registrationQuotaColumns,
  registrationQuotaWindows, registrationShownQuotaReading } from "./agent-registration-quota-probe.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import { writeRegistrationOwnerGrant } from "./agent-registration-access.js";
import { REGISTRATION_KEY_SQL, registrationAccess, registrationKeyValues, registrationOwnerGrant, spaceState } from "./agent-registration-rows.js";

const emptyConfiguration: SpaceAgentConfiguration = { workspaceReferences: [] };
/** Running Instances listed per registration; a machine runs far fewer at once. */
const RUNNING_INSTANCE_LIMIT = 32;

function catalogModelLimits(models: unknown) {
  return parseRegistrationResourceLimits({ models, workspaces: [], capabilities: [] });
}

function isoTime(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const time = new Date(value as string | Date).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function runningInstances(value: unknown): AgentRegistrationRunningInstance[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const since = isoTime(row.since);
    return typeof row.instanceId === "string" && typeof row.channelId === "string" &&
      typeof row.channelInstanceId === "string" && since
      ? [{ instanceId: row.instanceId, channelId: row.channelId, channelInstanceId: row.channelInstanceId, since }]
      : [];
  });
}

interface RegistrationCommand {
  key: SpaceAgentRegistrationKey;
  actorUserId: string;
  commandId: string;
}

function command(input: RegistrationCommand): SpaceAgentRegistrationKey {
  const key = parseSpaceAgentRegistrationKey(input.key);
  if ([input.actorUserId, input.commandId].some(value => typeof value !== "string" || !value ||
      value !== value.trim() || hasControlCharacter(value)) ||
      input.actorUserId.length > 300 || input.commandId.length > 200) {
    throw new RegistrationAccessError("invalid_registration_command", 400);
  }
  return key;
}

function displayName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || utf8ByteLength(value) > 80 ||
      hasControlCharacter(value)) throw new RegistrationAccessError("invalid_registration_name", 400);
  return value.trim();
}

function workspacePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 4_000 ||
      hasControlCharacter(value)) throw new RegistrationAccessError("invalid_registration_workspace", 400);
  return value;
}

async function requireMember(tx: DatabaseTransaction, spaceId: string, actor: string): Promise<string> {
  const rows = await tx.query({ name: "registration_control_member_v1", text: `SELECT role
    FROM data.space_members WHERE space_id=$1 AND user_id=$2 FOR SHARE`, values: [spaceId, actor], maxRows: 1 });
  if (!rows[0]) throw new RegistrationAccessError("registration_not_found", 404);
  return String(rows[0].role);
}

/** `byAgent`: the owner's Agent Run adds it, and has the owner's membership but
 * never an admin's exception to the Space's creation policy. */
async function requireOfferAuthority(tx: DatabaseTransaction, key: SpaceAgentRegistrationKey, actor: string,
  byAgent = false) {
  const role = byAgent ? (await requireMember(tx, key.spaceId, actor), "member") : await requireMember(tx, key.spaceId, actor);
  if (actor !== key.ownerUserId) throw new RegistrationAccessError("registration_owner_required", 403);
  const policy = await tx.query({ name: "registration_creation_policy_v2", text: `SELECT agent_creation_policy
    FROM data.space_member_creation_policies WHERE space_id=$1 FOR SHARE`, values: [key.spaceId], maxRows: 1 });
  if (policy[0] && policy[0].agent_creation_policy !== "members" && !["owner", "admin"].includes(role)) {
    throw new RegistrationAccessError("registration_creation_restricted", 403);
  }
}

/** Space placement is resolved by the owning gateway. This repository never
 * creates an independent Profile ID, modifies local installation settings, or
 * treats enrollment as an execution grant. */
async function anchorRegistrationKey(tx: DatabaseTransaction, key: SpaceAgentRegistrationKey,
  enrollment: Awaited<ReturnType<typeof enrollGlobalRegistration>>): Promise<void> {
  await tx.query({ name: "registration_space_key_anchor_v1", text: `INSERT INTO data.agent_registrations
        (owner_user_id,machine_id,harness,version,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      values: [key.ownerUserId, key.machineId, key.harness, enrollment.version, enrollment.createdAt, enrollment.updatedAt], maxRows: 0 });
}

export class PostgresAgentRegistrationRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly placement: DatabasePlacementContext) {
    if (database.cacheMode !== "disabled") throw new RegistrationAccessError("cached_authority_forbidden", 500);
  }

  private context(key: { spaceId: string }, requestId: string, operation: string) {
    if (key.spaceId !== this.placement.spaceId) throw new RegistrationAccessError("registration_not_found", 404);
    return { requestId, operation, placement: this.placement };
  }

  /** Explicit owner action. Duplicate offers return the same tuple without
   * overwriting an existing Space's configuration or enabling access. */
  async offer(input: RegistrationCommand & { displayName: string }) {
    const key = command(input), name = displayName(input.displayName);
    const digest = await digestCanonicalCloneCborV1({ key, displayName: name });
    if (input.actorUserId !== key.ownerUserId) throw new RegistrationAccessError("registration_owner_required", 403);
    await this.database.transaction(this.context(key, input.commandId, "registration.offer.preflight"),
      tx => requireOfferAuthority(tx, key, input.actorUserId));
    const enrollment = await enrollGlobalRegistration(this.database, { key, commandId: input.commandId, requestDigest: digest });
    return this.database.transaction(this.context(key, input.commandId, "registration.offer"), async tx => {
      await requireOfferAuthority(tx, key, input.actorUserId);
      const replay = await replayCommand(tx, input, "offer", digest);
      if (replay) return { key, ...replay };
      // On a non-directory shard this is an immutable key anchor copied from
      // global enrollment, solely for the composite FK. It owns no installation,
      // capacity, grant or mutable registration facts. Global reads never use it.
      await anchorRegistrationKey(tx, key, enrollment);
      await tx.query({ name: "registration_offer_space_v1", text: `INSERT INTO data.space_agent_registrations
        (space_id,owner_user_id,machine_id,harness,display_name,configuration_json,version,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,1,clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING`,
      values: [...registrationKeyValues(key), name, JSON.stringify(emptyConfiguration)], maxRows: 0 });
      const rows = await tx.query({ name: "registration_offer_result_v1", text: `SELECT version
        FROM data.space_agent_registrations WHERE ${REGISTRATION_KEY_SQL} FOR SHARE`, values: registrationKeyValues(key), maxRows: 1 });
      const version = Number(rows[0]!.version);
      await recordCommand(tx, input, key, "offer", digest, version);
      return { key, version, reused: false };
    });
  }

  /** A human adds an Agent on their own machine in one command: the machine
   * declares the harness (an existing declaration is kept), the Space offers
   * it, and it is granted the owner's Workspaces on that machine and enabled.
   * Only the owner may do this, under the Space's agent creation policy.
   * Adding it again is the owner's add-back: see `addBack`. */
  async create(input: RegistrationCommand & { displayName: string; environment: AgentRegistrationEnvironment;
    defaultWorkspace?: string; byAgent?: boolean }) {
    const key = command(input), name = displayName(input.displayName);
    const environment = parseAgentRegistrationEnvironment(input.environment);
    if (!environment.launch) throw new RegistrationAccessError("invalid_registration_environment", 400);
    const defaultWorkspace = input.defaultWorkspace === undefined ? undefined : workspacePath(input.defaultWorkspace);
    const digest = await digestCanonicalCloneCborV1({ key, name, environment, defaultWorkspace: defaultWorkspace ?? null });
    if (input.actorUserId !== key.ownerUserId) throw new RegistrationAccessError("registration_owner_required", 403);
    await this.database.transaction(this.context(key, input.commandId, "registration.create.preflight"),
      tx => requireOfferAuthority(tx, key, input.actorUserId, input.byAgent === true));
    // The global enrollment anchors the physical declaration, and both, with the
    // owner's Workspaces, live in the directory.
    const enrollment = await enrollGlobalRegistration(this.database, { key, commandId: input.commandId, requestDigest: digest });
    const workspaces = await this.database.transaction({ requestId: input.commandId,
      operation: "registration.environment.create" }, async tx => {
      await tx.query({ name: "registration_create_capacity_v1", text: `INSERT INTO control.machine_execution_capacity
        (owner_user_id,machine_id,max_concurrent,version) VALUES ($1,$2,1,1)
        ON CONFLICT (owner_user_id,machine_id) DO NOTHING`, values: [key.ownerUserId, key.machineId], maxRows: 0 });
      // An existing declaration is kept. The one thing an add writes onto it is
      // the access mode its owner confirms with this add, when it holds none.
      await tx.query({ name: "registration_create_environment_v2", text: `INSERT INTO control.agent_registration_environments AS held
        (owner_user_id,machine_id,harness,declaration_json,version) VALUES ($1,$2,$3,$4::jsonb,1)
        ON CONFLICT (owner_user_id,machine_id,harness) DO UPDATE SET
          declaration_json=jsonb_set(held.declaration_json,'{launch,access}',EXCLUDED.declaration_json->'launch'->'access'),
          version=held.version+1,updated_at=clock_timestamp()
        WHERE jsonb_typeof(held.declaration_json->'launch')='object' AND NOT (held.declaration_json->'launch' ? 'access')
          AND EXCLUDED.declaration_json->'launch' ? 'access'`,
      values: [key.ownerUserId, key.machineId, key.harness, JSON.stringify(environment)], maxRows: 0 });
      const rows = await tx.query({ name: "registration_create_workspaces_v1", text: `SELECT workspace_id,canonical_cwd
        FROM data.workspaces WHERE owner_user_id=$1 AND machine_id=$2 ORDER BY workspace_id LIMIT 101`,
      values: [key.ownerUserId, key.machineId], maxRows: 101 });
      if (rows.length > 100) throw new RegistrationAccessError("registration_workspaces_limit", 409);
      return rows.map(row => ({ id: String(row.workspace_id), cwd: String(row.canonical_cwd) }));
    });
    const references = workspaces.map(workspace => workspace.id);
    const routingWorkspace = defaultWorkspace === undefined ? undefined
      : workspaces.find(workspace => workspace.cwd === defaultWorkspace)?.id;
    const configuration = parseSpaceAgentConfiguration({ workspaceReferences: references,
      // Whether it takes work is the owner's environment switch, not a Space setting.
      routing: { schemaVersion: 1, enabled: true, models: environment.models,
        description: environment.description, ...(routingWorkspace ? { defaultWorkspace: routingWorkspace } : {}) } });
    const limits = JSON.stringify(parseRegistrationResourceLimits({ workspaces: references,
      models: environment.models, capabilities: [] }));
    return this.database.transaction(this.context(key, input.commandId, "registration.create"), async tx => {
      await requireOfferAuthority(tx, key, input.actorUserId, input.byAgent === true);
      const replay = await replayCommand(tx, input, "create", digest);
      if (replay) return { key, ...replay };
      await anchorRegistrationKey(tx, key, enrollment);
      const created = await tx.query({ name: "registration_create_space_v1", text: `INSERT INTO data.space_agent_registrations
        (space_id,owner_user_id,machine_id,harness,display_name,configuration_json,version,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,1,clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING RETURNING version`,
      values: [...registrationKeyValues(key), name, JSON.stringify(configuration)], maxRows: 1 });
      if (!created[0]) {
        const version = await addBack(tx, key, input, digest, workspaces.map(workspace => workspace.id), routingWorkspace);
        await recordCommand(tx, input, key, "create", digest, version);
        return { key, version, reused: false };
      }
      await tx.query({ name: "registration_create_access_v1", text: `INSERT INTO data.space_agent_registration_access
        (space_id,owner_user_id,machine_id,harness,grant_state,grant_revision,grant_execution_revision,grant_limits,
         policy_state,policy_revision,policy_execution_revision,policy_limits,updated_at)
        VALUES ($1,$2,$3,$4,'active',1,1,$5::jsonb,'enabled',1,1,$5::jsonb,clock_timestamp())`,
      values: [...registrationKeyValues(key), limits], maxRows: 0 });
      await recordCommand(tx, input, key, "create", digest, 1);
      return { key, version: 1, reused: false };
    });
  }

  /** The retired Agent Role's `role_json` column is neither written nor read;
   * a later contract migration drops it. */
  async configure(input: RegistrationCommand & { expectedVersion: number; displayName: string;
    configuration: SpaceAgentConfiguration }) {
    const key = command(input), name = displayName(input.displayName);
    const configuration = parseSpaceAgentConfiguration(input.configuration);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
        input.expectedVersion >= Number.MAX_SAFE_INTEGER) throw new RegistrationAccessError("invalid_registration_version", 400);
    const digest = await digestCanonicalCloneCborV1({ key, name, configuration, expectedVersion: input.expectedVersion });
    return this.database.transaction(this.context(key, input.commandId, "registration.configure"), async tx => {
      const role = await requireMember(tx, key.spaceId, input.actorUserId);
      if (!["owner", "admin"].includes(role)) throw new RegistrationAccessError("space_policy_authority_required", 403);
      await requireMember(tx, key.spaceId, key.ownerUserId);
      const replay = await replayCommand(tx, input, "configure", digest);
      if (replay) return { key, ...replay };
      const rows = await tx.query({ name: "registration_configuration_lock_v1", text: `SELECT version
        FROM data.space_agent_registrations WHERE ${REGISTRATION_KEY_SQL} FOR UPDATE`, values: registrationKeyValues(key), maxRows: 1 });
      if (!rows[0]) throw new RegistrationAccessError("registration_not_found", 404);
      if (Number(rows[0].version) !== input.expectedVersion) throw new RegistrationAccessError("registration_version_conflict", 409);
      const access = await tx.query({ name: "registration_configuration_grant_v1", text: `SELECT grant_state,grant_revision,grant_execution_revision,grant_limits
        FROM data.space_agent_registration_access WHERE ${REGISTRATION_KEY_SQL} FOR SHARE`, values: registrationKeyValues(key), maxRows: 1 });
      if (!access[0]) throw new RegistrationAccessError("registration_not_granted", 403);
      const grant = registrationOwnerGrant(access[0]);
      if (grant.state !== "active" || !registrationLimitsWithin(spaceConfigurationResources(configuration), grant.limits)) {
        throw new RegistrationAccessError("space_configuration_exceeds_owner_grant", 403);
      }
      await tx.query({ name: "registration_configuration_update_v3", text: `UPDATE data.space_agent_registrations
        SET display_name=$5,configuration_json=$6::jsonb,version=version+1,updated_at=clock_timestamp()
        WHERE ${REGISTRATION_KEY_SQL}`, values: [...registrationKeyValues(key), name, JSON.stringify(configuration)], maxRows: 0 });
      const version = input.expectedVersion + 1;
      await recordCommand(tx, input, key, "configure", digest, version);
      return { key, version, reused: false };
    });
  }

  async get(input: { key: SpaceAgentRegistrationKey; actorUserId: string; requestId: string }) {
    const key = command({ ...input, commandId: input.requestId });
    return this.database.transaction(this.context(key, input.requestId, "registration.get"), async tx => {
      const role = await requireMember(tx, key.spaceId, input.actorUserId);
      const privileged = input.actorUserId === key.ownerUserId || ["owner", "admin"].includes(role);
      if (!privileged) {
        const visible = await tx.query({ name: "registration_get_visibility_v1", text: `SELECT 1
          FROM data.space_agent_registration_access a JOIN data.space_members m
            ON m.space_id=a.space_id AND m.user_id=a.owner_user_id
          WHERE a.space_id=$1 AND a.owner_user_id=$2 AND a.machine_id=$3 AND a.harness=$4 AND a.grant_state='active'`,
        values: registrationKeyValues(key), maxRows: 1 });
        if (!visible[0]) throw new RegistrationAccessError("registration_not_found", 404);
      }
      const rows = await tx.query<QueryResultRow>({ name: "registration_control_get_v3", text: `SELECT
        display_name,configuration_json,version FROM data.space_agent_registrations WHERE ${REGISTRATION_KEY_SQL}`,
      values: registrationKeyValues(key), maxRows: 1 });
      if (!rows[0]) throw new RegistrationAccessError("registration_not_found", 404);
      const row = rows[0];
      const accessRows = privileged ? await tx.query({ name: "registration_control_access_v1", text: `SELECT *
        FROM data.space_agent_registration_access WHERE ${REGISTRATION_KEY_SQL}`, values: registrationKeyValues(key), maxRows: 1 }) : [];
      const current = accessRows[0];
      const access = current ? registrationAccess(current) : null;
      // Ordinary Space members can select the label; configuration (including
      // private workspace choices) stays privileged.
      return { key, displayName: String(row.display_name), version: Number(row.version),
        canManageOwnerGrant: input.actorUserId === key.ownerUserId, canConfigureSpace: ["owner", "admin"].includes(role),
        canRemoveFromSpace: privileged,
        ...(privileged
          ? { configuration: parseSpaceAgentConfiguration(row.configuration_json), access } : {}) };
    });
  }

  /**
   * Rewrites what the Space says a harness is for. A Space owner or admin may,
   * and so may anyone with an Agent of that harness here: they describe what
   * their own Agent is good at. The text is free; saving the same text again
   * changes nothing.
   */
  async describe(input: { spaceId: string; actorUserId: string; requestId: string } & HarnessProfileCommand):
  Promise<{ harness: string } & SpaceHarnessProfile> {
    const { harness, description, expectedRevision } = parseHarnessProfileCommand({ harness: input.harness,
      description: input.description, ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) });
    if (!input.actorUserId || input.actorUserId.length > 300) throw new RegistrationAccessError("invalid_registration_command", 400);
    return this.database.transaction(this.context(input, input.requestId, "registration.describe"), async tx => {
      const role = await requireMember(tx, input.spaceId, input.actorUserId);
      // The harness is described only where it is an Agent of the Space.
      const offered = await tx.query({ name: "harness_profile_offered_v1", text: `SELECT
        COALESCE(bool_or(owner_user_id=$3),FALSE) AS owns_harness,count(*)::int AS locations
        FROM (SELECT owner_user_id FROM data.space_agent_registrations WHERE space_id=$1 AND harness=$2 LIMIT 501) offered`,
      values: [input.spaceId, harness, input.actorUserId], maxRows: 1 });
      if (!offered[0] || Number(offered[0].locations) === 0) throw new RegistrationAccessError("registration_not_found", 404);
      if (!["owner", "admin"].includes(role) && offered[0].owns_harness !== true) {
        throw new RegistrationAccessError("harness_profile_authority_required", 403);
      }
      // Writers of one profile take turns, including the first, which has no row to lock.
      await tx.query({ name: "harness_profile_lock_v1", text: `SELECT pg_advisory_xact_lock(
        hashtextextended(jsonb_build_array('harness-profile',$1::text,$2::text)::text,0))`,
      values: [input.spaceId, harness], maxRows: 1 });
      const rows = await tx.query({ name: "harness_profile_current_v1", text: `SELECT description,revision
        FROM data.space_harness_profiles WHERE space_id=$1 AND harness=$2`, values: [input.spaceId, harness], maxRows: 1 });
      const current = { description: String(rows[0]?.description ?? ""), revision: Number(rows[0]?.revision ?? 0) };
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        throw new RegistrationAccessError("harness_profile_revision_conflict", 409);
      }
      if (description === current.description) return { harness, ...current };
      await tx.query({ name: "harness_profile_write_v1", text: `INSERT INTO data.space_harness_profiles
        (space_id,harness,description,revision,updated_at) VALUES ($1,$2,$3,$4,clock_timestamp())
        ON CONFLICT (space_id,harness) DO UPDATE SET description=EXCLUDED.description,revision=EXCLUDED.revision,
          updated_at=EXCLUDED.updated_at`,
      values: [input.spaceId, harness, description, current.revision + 1], maxRows: 0 });
      return { harness, description, revision: current.revision + 1 };
    });
  }

  /** A Space member may ask for the Space's quota to be read again. */
  async requireReader(input: { spaceId: string; actorUserId: string; requestId: string }): Promise<void> {
    await this.database.transaction(this.context(input, input.requestId, "registration.reader"),
      tx => requireMember(tx, input.spaceId, input.actorUserId));
  }

  async list(input: { spaceId: string; actorUserId: string; requestId: string; cursor?: string | null; limit?: number }) {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !input.actorUserId || input.actorUserId.length > 300) {
      throw new RegistrationAccessError("invalid_registration_page", 400);
    }
    let cursor: string[] | null = null;
    if (input.cursor !== undefined && input.cursor !== null) {
      try {
        if (input.cursor.length > 2_000) throw new Error();
        const parsed = JSON.parse(input.cursor);
        if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error();
        const key = parseSpaceAgentRegistrationKey({ spaceId: input.spaceId,
          ownerUserId: parsed[0], machineId: parsed[1], harness: parsed[2] });
        cursor = [key.ownerUserId, key.machineId, key.harness];
      } catch { throw new RegistrationAccessError("invalid_registration_cursor", 400); }
    }
    const page = await this.database.transaction({ ...this.context(input, input.requestId, "registration.list"),
      statement: "single_read" }, async tx => {
      // Running Instances come from the owner's live Runs on that machine (a
      // partial index keeps this to what is running now), bound to this
      // registration in this Space, in Channels the reader may read.
      // A catalog observed in the last 24 hours was written to its Instance
      // row then, and that write stamps updated_at: scanning only Instances
      // updated in the last 48 hours once per page (via instances_updated_at_idx)
      // avoids probing every historical run_agent_registrations row per
      // registration, and jsonb_to_record detoasts each presentation once.
      // Identical model/parameter catalogs across registrations on the page
      // ship once by digest and are restored below.
      // Membership and visibility share the read's snapshot. The outer row
      // distinguishes a member's empty page from a nonmember without a lock.
      // The catalog lists model choices, not the workspace and capability
      // grants or the instructions used to launch a Run.
      const result = await tx.query({ name: "registration_catalog_page_v10", text: `WITH recent AS MATERIALIZED (
        SELECT binding.owner_user_id,binding.machine_id,binding.harness,i.instance_id,
          CASE WHEN jsonb_typeof(p.models)='array' AND pg_input_is_valid(p."modelsObservedAt",'timestamp with time zone')
            THEN CASE WHEN p."modelsObservedAt"::timestamptz BETWEEN statement_timestamp()-interval '24 hours' AND statement_timestamp()
              THEN p."modelsObservedAt"::timestamptz END END AS models_ts,
          p."modelsObservedAt" AS models_observed_at,
          CASE WHEN jsonb_typeof(p.parameters)='array' AND pg_input_is_valid(p."parametersObservedAt",'timestamp with time zone')
            THEN CASE WHEN p."parametersObservedAt"::timestamptz BETWEEN statement_timestamp()-interval '24 hours' AND statement_timestamp()
              THEN p."parametersObservedAt"::timestamptz END END AS parameters_ts,
          p."parametersObservedAt" AS parameters_observed_at,
          p.model AS parameter_model
        FROM data.instances i
        JOIN data.run_agent_registrations binding ON binding.run_id=i.run_id
        CROSS JOIN LATERAL jsonb_to_record(i.presentation_json) AS p(
          models jsonb,"modelsObservedAt" text,
          parameters jsonb,"parametersObservedAt" text,model text
        )
        WHERE binding.space_id=$1 AND i.updated_at>=statement_timestamp()-interval '48 hours'
      ),
      latest_models AS (
        SELECT DISTINCT ON (owner_user_id,machine_id,harness)
          owner_user_id,machine_id,harness,instance_id,models_observed_at
        FROM recent WHERE models_ts IS NOT NULL
        ORDER BY owner_user_id,machine_id,harness,models_ts DESC,instance_id
      ),
      latest_params AS (
        SELECT DISTINCT ON (owner_user_id,machine_id,harness)
          owner_user_id,machine_id,harness,instance_id,parameters_observed_at,parameter_model
        FROM recent WHERE parameters_ts IS NOT NULL
        ORDER BY owner_user_id,machine_id,harness,parameters_ts DESC,instance_id
      ),
      listed AS (
        SELECT reader.role AS reader_role,page.* FROM
        (SELECT role FROM data.space_members WHERE space_id=$1 AND user_id=$2) reader
        LEFT JOIN LATERAL (SELECT
        r.owner_user_id,r.machine_id,r.harness,r.display_name,r.version,
        (r.configuration_json - ARRAY['instructions','reasoningEffort','workingMode','workspaceReferences',
          'role','secretReferences']) || '{"workspaceReferences":[]}'::jsonb AS configuration_json,
        profile.description AS profile_description,profile.revision AS profile_revision,
        EXISTS (SELECT 1 FROM data.space_agent_registrations own WHERE own.space_id=r.space_id
          AND own.harness=r.harness AND own.owner_user_id=$2) AS owns_harness,
        m.user_id AS current_owner,m.display_name AS owner_name,a.grant_state,a.policy_state,
        CASE WHEN a.grant_limits IS NOT NULL AND a.policy_limits IS NOT NULL
          THEN jsonb_build_array(a.grant_limits->'models',a.policy_limits->'models') END AS model_limits,
        lm.instance_id AS models_instance_id,lm.models_observed_at AS catalog_observed_at,
        encode(sha256(convert_to((mi.presentation_json->'models')::text,'UTF8')),'hex') AS catalog_models_digest,
        lp.instance_id AS params_instance_id,lp.parameter_model,lp.parameters_observed_at,
        encode(sha256(convert_to((pi.presentation_json->'parameters')::text,'UTF8')),'hex') AS catalog_parameters_digest,
        running.instances AS running
        FROM data.space_agent_registrations r
        LEFT JOIN data.space_members m ON m.space_id=r.space_id AND m.user_id=r.owner_user_id
        LEFT JOIN data.space_agent_registration_access a ON a.space_id=r.space_id AND a.owner_user_id=r.owner_user_id
          AND a.machine_id=r.machine_id AND a.harness=r.harness
        LEFT JOIN data.space_harness_profiles profile ON profile.space_id=r.space_id AND profile.harness=r.harness
        LEFT JOIN latest_models lm ON lm.owner_user_id=r.owner_user_id AND lm.machine_id=r.machine_id AND lm.harness=r.harness
        LEFT JOIN data.instances mi ON mi.instance_id=lm.instance_id
        LEFT JOIN latest_params lp ON lp.owner_user_id=r.owner_user_id AND lp.machine_id=r.machine_id AND lp.harness=r.harness
        LEFT JOIN data.instances pi ON pi.instance_id=lp.instance_id
        LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('instanceId',live.instance_id,'channelId',live.channel_id,
            'channelInstanceId',live.channel_instance_id::text,'since',live.created_at)
            ORDER BY live.created_at,live.instance_id) AS instances
          FROM (SELECT i.instance_id,i.channel_id,i.channel_instance_id,run.created_at
            FROM data.runs run
            JOIN data.run_agent_registrations binding ON binding.run_id=run.run_id
            JOIN data.instances i ON i.run_id=run.run_id
            JOIN data.channels channel ON channel.channel_id=i.channel_id
            WHERE run.owner_user_id=r.owner_user_id AND run.metadata_json->>'machineId'=r.machine_id
              AND run.status IN (${ACTIVE_RUN_STATUS_SQL})
              AND binding.space_id=r.space_id AND binding.owner_user_id=r.owner_user_id
              AND binding.machine_id=r.machine_id AND binding.harness=r.harness AND channel.space_id=r.space_id
              AND ${channelCapabilityPredicate({ capability: "runtime_history_read", channelAlias: "channel",
                principalKindSql: "'user'", principalIdSql: "$2" })}
            ORDER BY run.created_at,i.instance_id LIMIT ${RUNNING_INSTANCE_LIMIT}) live) running ON TRUE
        WHERE r.space_id=$1 AND (reader.role IN ('owner','admin') OR r.owner_user_id=$2 OR (m.user_id IS NOT NULL AND a.grant_state='active'))
          AND ($3::text IS NULL OR (r.owner_user_id,r.machine_id,r.harness)>($3,$4,$5))
        ORDER BY r.owner_user_id,r.machine_id,r.harness LIMIT $6) page ON TRUE
      )
      SELECT listed.*,
        CASE WHEN listed.catalog_models_digest IS NOT NULL AND row_number() OVER (
          PARTITION BY listed.catalog_models_digest ORDER BY listed.owner_user_id,listed.machine_id,listed.harness)=1
          THEN (SELECT shown.presentation_json->'models' FROM data.instances shown WHERE shown.instance_id=listed.models_instance_id)
        END AS catalog_models,
        CASE WHEN listed.catalog_parameters_digest IS NOT NULL AND row_number() OVER (
          PARTITION BY listed.catalog_parameters_digest ORDER BY listed.owner_user_id,listed.machine_id,listed.harness)=1
          THEN (SELECT shown.presentation_json->'parameters' FROM data.instances shown WHERE shown.instance_id=listed.params_instance_id)
        END AS catalog_parameters
      FROM listed
      ORDER BY listed.owner_user_id,listed.machine_id,listed.harness`,
      values: [input.spaceId, input.actorUserId, ...(cursor ?? [null, null, null]), limit + 1], maxRows: limit + 1 });
      if (!result[0]) throw new RegistrationAccessError("registration_not_found", 404);
      const admin = ["owner", "admin"].includes(String(result[0].reader_role));
      const rows = result.filter(row => row.owner_user_id !== null);
      const current = rows.slice(0, limit), last = current.at(-1);
      const sharedCatalog = (digestColumn: string, valueColumn: string) => {
        const values = new Map<string, unknown>();
        for (const row of current) {
          const digest = row[digestColumn], value = row[valueColumn];
          if (typeof digest === "string" && value !== null && value !== undefined) values.set(digest, value);
        }
        return (row: QueryResultRow) => {
          const digest = row[digestColumn];
          if (typeof digest !== "string") return null;
          if (!values.has(digest)) throw new DatabaseContractError("Registration catalog payload is missing from its read");
          return values.get(digest);
        };
      };
      const catalogModels = sharedCatalog("catalog_models_digest", "catalog_models");
      const catalogParameters = sharedCatalog("catalog_parameters_digest", "catalog_parameters");
      const registrations: AgentRegistrationSummary[] = current.map(row => {
        const key = parseSpaceAgentRegistrationKey({ spaceId: input.spaceId, ownerUserId: row.owner_user_id,
          machineId: row.machine_id, harness: row.harness });
        const configuration = parseSpaceAgentConfiguration(row.configuration_json);
        const allowed = row.model_limits ? intersectRegistrationLimits(
          catalogModelLimits(row.model_limits[0]), catalogModelLimits(row.model_limits[1])) : null;
        const models = [...new Set([...(configuration.model ? [configuration.model] : []), ...(configuration.routing?.models ?? [])])]
          .filter(model => allowed?.models.includes(model)).sort();
        // An empty model list allows the runtime default; the environment pass
        // below offers the runtime's whole catalog where its daemon applies one.
        // No fresh observation stays absent.
        const parameterObservation = harnessParameterObservation(catalogParameters(row), row.parameters_observed_at,
          row.parameter_model, models, Date.now());
        return { ...parameterObservation,
          key, displayName: String(row.display_name), version: Number(row.version),
          // With no declared models the runtime's catalog stays whole; the environment pass below narrows it.
          modelCatalog: routingModelCatalogObservation(catalogModels(row), row.catalog_observed_at, Date.now())?.value
            .filter(model => !models.length || models.includes(model.model)),
          ownerName: String(row.owner_name || "Space member"), machineName: "Registered machine", models,
          routingReady: row.current_owner !== null && row.grant_state === "active" && row.policy_state === "enabled" &&
            configuration.routing?.enabled === true && (configuration.routing.models.length === 0 ||
              configuration.routing.models.some(model => models.includes(model))),
          state: !row.current_owner ? "revoked" : !row.grant_state ? "unshared"
            : row.grant_state === "revoked" ? "revoked" : spaceState(row.policy_state),
          canManageOwnerGrant: input.actorUserId === key.ownerUserId, canConfigureSpace: admin,
          canRemoveFromSpace: admin || input.actorUserId === key.ownerUserId,
          profile: { description: String(row.profile_description ?? ""), revision: Number(row.profile_revision ?? 0) },
          canDescribe: admin || row.owns_harness === true,
          live: { machine: { online: false }, running: runningInstances(row.running) } };
      });
      return { registrations, nextCursor: rows.length > limit && last
        ? JSON.stringify([last.owner_user_id, last.machine_id, last.harness]) : null };
    });
    if (!page.registrations.length) return page;
    // Enrich only the already-authorized locations. Global lookups never return
    // other Space tasks, configuration or machine inventory.
    // The quota is the observation a launch reads for this registration's pool,
    // while it is current.
    const labels = await this.database.transaction({ requestId: input.requestId, operation: "registration.machine-labels",
      statement: "single_read" },
      tx => tx.query({ name: "registration_catalog_machine_labels_v13", text: `SELECT
        requested.owner,requested.machine,requested.harness,machine.name,machine.auto_assign,
        e.declaration_json,daemon.online,daemon.last_seen_at,daemon.resources,daemon.platform,daemon.native_models,
        ${registrationQuotaColumns("quota")}
        FROM jsonb_to_recordset($1::jsonb) AS requested(owner text,machine text,harness text)
        LEFT JOIN control.agent_registration_environments e ON e.owner_user_id=requested.owner
          AND e.machine_id=requested.machine AND e.harness=requested.harness
        LEFT JOIN data.machines machine ON machine.owner_user_id=requested.owner AND machine.machine_id=requested.machine
        LEFT JOIN LATERAL (SELECT bool_or(status='online') AS online,max(updated_at) AS last_seen_at,
          -- Only the live connection's own sample is current load.
          (array_agg(metadata_json->'machineResources' ORDER BY updated_at DESC) FILTER (WHERE status='online'
            AND metadata_json->'machineResources'->>'connectionEpoch'=connection_epoch::text))[1] AS resources,
          -- The OS the machine's daemon last reported, shown with its row.
          (array_agg(metadata_json->>'platform' ORDER BY updated_at DESC)
            FILTER (WHERE metadata_json->>'platform' IS NOT NULL))[1] AS platform,
          -- Whether its online daemon starts a runtime on a model from the runtime's own catalog.
          bool_or(status='online' AND capabilities_json ? 'registration_native_model_v1') AS native_models
          FROM data.machine_daemons WHERE owner_user_id=requested.owner AND machine_id=requested.machine) daemon ON TRUE
        ${currentRegistrationQuotaJoin("quota")}`,
      values: [JSON.stringify(page.registrations.map(row => ({ owner: row.key.ownerUserId,
        machine: row.key.machineId, harness: row.key.harness })))], maxRows: limit }));
    return { ...page, registrations: page.registrations.map(row => {
      const label = labels.find(label => label.owner === row.key.ownerUserId && label.machine === row.key.machineId && label.harness === row.key.harness);
      const environment = label?.declaration_json ? parseStoredAgentRegistrationEnvironment(label.declaration_json) : null;
      // The physical environment bounds the Space's models exactly as a launch does.
      const declared = row.models.filter(model => environment?.models.includes(model));
      // A machine whose owner declared no models runs the Space's models from
      // the runtime's own catalog, on a daemon that switches to one (as a launch does).
      const fromCatalog = environment && !environment.models.length && label?.native_models === true
        ? row.models.filter(model => row.modelCatalog?.some(option => routingModelOptionNamed(option, model))) : [];
      const models = [...declared, ...fromCatalog];
      // With no declared models the runtime's default model is the one that runs and its efforts stay
      // selectable; a daemon that switches the runtime to a catalog model offers the whole catalog.
      const nativeModels = !row.models.length && label?.native_models === true && Boolean(row.modelCatalog?.length);
      const reported = row.modelCatalog?.filter(model => row.models.length
        ? models.some(name => name === model.model || routingModelOptionNamed(model, name))
        : nativeModels || model.model === row.parameterModel);
      const blocker: AgentRegistrationSummary["routingBlocker"] = !environment ? "owner_environment_missing"
        : !environment.enabled ? "owner_environment_disabled" : !row.routingReady ? "space_setup"
          : row.models.length && !models.length ? "model_unavailable" : undefined;
      const lastSeenAt = isoTime(label?.last_seen_at);
      const resources = label?.online === true ? machineResourceObservation(label.resources, Date.now()) : undefined;
      const platform = machinePlatform(label?.platform);
      const reading = registrationShownQuotaReading(label);
      const windows = registrationQuotaWindows(label);
      const account = registrationQuotaAccount(label);
      // A provider account's headroom is its owner's; the Space's owners and admins manage its use.
      const { quota, balance } = row.canConfigureSpace || row.canManageOwnerGrant
        ? registrationLiveQuota(reading, windows, account) : {};
      const resolved = environment ? agentLaunchAccess(environment.launch, agentPresetById(row.key.harness)) : undefined;
      const access = resolved ? { ...resolved.access, confirmed: resolved.confirmed } : undefined;
      return { ...row, ...(access ? { access } : {}), models, modelCatalog: reported, ...(nativeModels ? { nativeModels: true as const } : {}), routingReady: !blocker, ...(blocker ? { routingBlocker: blocker } : {}),
        machineName: String(label?.name || row.machineName),
        live: { machine: { online: label?.online === true, ...(lastSeenAt ? { lastSeenAt } : {}),
          ...(resources ? { resources } : {}), ...(platform ? { platform } : {}),
          // Its owner keeps it out of automatic assignment: only a summon naming it runs here.
          ...(label?.auto_assign === false ? { autoAssign: false as const } : {}) },
          running: row.live?.running ?? [], ...(quota ? { quota } : {}),
          ...(balance ? { balance } : {}) } };
    }) };
  }
}

/** Daemons report `windows`/`macos`/`linux`; the desktop bridge Node's `win32`/`darwin`. */
function machinePlatform(value: unknown): AgentRegistrationMachinePlatform | undefined {
  if (value === "windows" || value === "win32") return "windows";
  if (value === "macos" || value === "darwin") return "macos";
  if (value === "linux") return "linux";
  return undefined;
}

/** The owner adds an existing registration again. Workspaces registered on
 * the machine since the grant was last written are granted and configured, a
 * revoked grant becomes active, and a default Workspace the owner names is
 * routed to. Workspaces already granted keep whatever the Space configured for
 * them, and a Space's disable is left as it is. Returns the registration version. */
async function addBack(tx: DatabaseTransaction, key: SpaceAgentRegistrationKey, input: RegistrationCommand,
  digest: string, ownerWorkspaces: string[], defaultWorkspace: string | undefined): Promise<number> {
  const rows = await tx.query({ name: "registration_add_back_lock_v1", text: `SELECT version,configuration_json
    FROM data.space_agent_registrations WHERE ${REGISTRATION_KEY_SQL} FOR UPDATE`, values: registrationKeyValues(key), maxRows: 1 });
  if (!rows[0]) throw new RegistrationAccessError("registration_not_found", 404);
  const accessRows = await tx.query({ name: "registration_add_back_access_v1", text: `SELECT grant_state,grant_revision,
    grant_execution_revision,grant_limits FROM data.space_agent_registration_access WHERE ${REGISTRATION_KEY_SQL} FOR UPDATE`,
  values: registrationKeyValues(key), maxRows: 1 });
  // An offer that was never granted has no owner limits to extend.
  if (!accessRows[0]) throw new RegistrationAccessError("registration_exists", 409);
  const grant = registrationOwnerGrant(accessRows[0]);
  const added = ownerWorkspaces.filter(id => !grant.limits.workspaces.includes(id));
  const current = parseSpaceAgentConfiguration(rows[0].configuration_json);
  const references = [...new Set([...current.workspaceReferences, ...added])];
  const routing = current.routing && defaultWorkspace && references.includes(defaultWorkspace) &&
    current.routing.defaultWorkspace !== defaultWorkspace ? { ...current.routing, defaultWorkspace } : current.routing;
  let version = Number(rows[0].version);
  if (added.length || routing !== current.routing) {
    const configuration = parseSpaceAgentConfiguration({ ...current, workspaceReferences: references,
      ...(routing ? { routing } : {}) });
    await tx.query({ name: "registration_add_back_configuration_v1", text: `UPDATE data.space_agent_registrations
      SET configuration_json=$5::jsonb,version=version+1,updated_at=clock_timestamp() WHERE ${REGISTRATION_KEY_SQL}`,
    values: [...registrationKeyValues(key), JSON.stringify(configuration)], maxRows: 0 });
    version += 1;
  }
  if (!added.length && grant.state === "active") return version;
  const limits = parseRegistrationResourceLimits({ ...grant.limits, workspaces: [...grant.limits.workspaces, ...added] });
  await writeRegistrationOwnerGrant(tx, key, grant, { ...input, state: "active", limits, requestDigest: digest });
  return version;
}

async function replayCommand(tx: DatabaseTransaction, input: RegistrationCommand, kind: string, digest: string) {
  // Serialize a replay key before inspecting it. This is a lock, not an identity.
  await tx.query({ name: "registration_command_lock_v1", text: `SELECT pg_advisory_xact_lock(
    hashtextextended(jsonb_build_array('registration-command',$1::text,$2::text)::text,0))`,
  values: [input.actorUserId, input.commandId], maxRows: 1 });
  const rows = await tx.query({ name: "registration_command_replay_v1", text: `SELECT command_kind,request_digest,result_version
    FROM data.agent_registration_commands WHERE actor_user_id=$1 AND command_id=$2`,
  values: [input.actorUserId, input.commandId], maxRows: 1 });
  if (!rows[0]) return null;
  if (rows[0].command_kind !== kind || rows[0].request_digest !== digest) {
    throw new RegistrationAccessError("idempotency_mismatch", 409);
  }
  return { version: Number(rows[0].result_version), reused: true };
}

async function recordCommand(tx: DatabaseTransaction, input: RegistrationCommand, key: SpaceAgentRegistrationKey,
  kind: string, digest: string, version: number) {
  await tx.query({ name: "registration_command_record_v1", text: `INSERT INTO data.agent_registration_commands
    (actor_user_id,command_id,space_id,owner_user_id,machine_id,harness,command_kind,request_digest,result_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  values: [input.actorUserId, input.commandId, ...registrationKeyValues(key), kind, digest, version], maxRows: 0 });
}
