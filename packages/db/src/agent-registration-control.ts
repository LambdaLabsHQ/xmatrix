import { harnessParameterObservation, machineResourceObservation, hasControlCharacter } from "@xmatrix/protocol";
import { ACTIVE_RUN_STATUS_SQL, digestCanonicalCloneCborV1, parseSpaceAgentRegistrationKey, parseSpaceAgentConfiguration,
  registrationLimitsWithin, spaceConfigurationResources,
  parseRegistrationResourceLimits, intersectRegistrationLimits,
  parseAgentRegistrationEnvironment, routingModelCatalogObservation,
  type AgentRegistrationEnvironment, type AgentRegistrationMachinePlatform, type AgentRegistrationRunningInstance, type AgentRegistrationSummary,
  currentRoutingQuotaWindows, parseLlmQuotaAccount, type SpaceAgentRegistrationKey, type SpaceAgentConfiguration , utf8ByteLength } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabasePlacementContext } from "./context.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";
import { enrollGlobalRegistration } from "./agent-registration-enrollment.js";
import { currentRegistrationQuotaJoin, registrationQuotaReading } from "./agent-registration-quota-probe.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import { writeRegistrationOwnerGrant } from "./agent-registration-access.js";
import { REGISTRATION_KEY_SQL, registrationAccess, registrationKeyValues, registrationOwnerGrant, spaceState } from "./agent-registration-rows.js";

const emptyConfiguration: SpaceAgentConfiguration = { workspaceReferences: [] };
/** Running Instances listed per registration; a machine runs far fewer at once. */
const RUNNING_INSTANCE_LIMIT = 32;

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
      ? [{ instanceId: row.instanceId, channelId: row.channelId, channelInstanceId: row.channelInstanceId, since,
        working: row.working === true }]
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
      await tx.query({ name: "registration_create_environment_v1", text: `INSERT INTO control.agent_registration_environments
        (owner_user_id,machine_id,harness,declaration_json,version) VALUES ($1,$2,$3,$4::jsonb,1)
        ON CONFLICT (owner_user_id,machine_id,harness) DO NOTHING`,
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
    const page = await this.database.transaction(this.context(input, input.requestId, "registration.list"), async tx => {
      const role = await requireMember(tx, input.spaceId, input.actorUserId);
      const admin = ["owner", "admin"].includes(role);
      // Running Instances come from the owner's live Runs on that machine (a
      // partial index keeps this to what is running now), bound to this
      // registration in this Space, in Channels the reader may read.
      const rows = await tx.query({ name: "registration_catalog_page_v6", text: `SELECT
        r.owner_user_id,r.machine_id,r.harness,r.display_name,r.configuration_json,r.version,
        m.user_id AS current_owner,m.display_name AS owner_name,a.grant_state,a.policy_state,a.grant_limits,a.policy_limits, catalog.models AS catalog_models,catalog.observed_at AS catalog_observed_at,
        parameter_catalog.parameters AS catalog_parameters,parameter_catalog.parameter_model,parameter_catalog.parameters_observed_at,
        running.instances AS running
        FROM data.space_agent_registrations r
        LEFT JOIN data.space_members m ON m.space_id=r.space_id AND m.user_id=r.owner_user_id
        LEFT JOIN data.space_agent_registration_access a ON a.space_id=r.space_id AND a.owner_user_id=r.owner_user_id
          AND a.machine_id=r.machine_id AND a.harness=r.harness
        LEFT JOIN LATERAL (SELECT i.presentation_json->'models' AS models,
          i.presentation_json->>'modelsObservedAt' AS observed_at
          FROM data.run_agent_registrations binding JOIN data.instances i ON i.run_id=binding.run_id
          WHERE binding.space_id=r.space_id AND binding.owner_user_id=r.owner_user_id
            AND binding.machine_id=r.machine_id AND binding.harness=r.harness
            AND jsonb_typeof(i.presentation_json->'models')='array'
            AND CASE WHEN pg_input_is_valid(i.presentation_json->>'modelsObservedAt','timestamp with time zone')
              THEN (i.presentation_json->>'modelsObservedAt')::timestamptz BETWEEN statement_timestamp()-interval '24 hours' AND statement_timestamp()
              ELSE FALSE END
          ORDER BY (i.presentation_json->>'modelsObservedAt')::timestamptz DESC,i.instance_id LIMIT 1) catalog ON TRUE
        LEFT JOIN LATERAL (SELECT i.presentation_json->'parameters' AS parameters,
          i.presentation_json->>'model' AS parameter_model,i.presentation_json->>'parametersObservedAt' AS parameters_observed_at
          FROM data.run_agent_registrations binding JOIN data.instances i ON i.run_id=binding.run_id
          WHERE binding.space_id=r.space_id AND binding.owner_user_id=r.owner_user_id
            AND binding.machine_id=r.machine_id AND binding.harness=r.harness
            AND jsonb_typeof(i.presentation_json->'parameters')='array'
            AND CASE WHEN pg_input_is_valid(i.presentation_json->>'parametersObservedAt','timestamp with time zone')
              THEN (i.presentation_json->>'parametersObservedAt')::timestamptz BETWEEN statement_timestamp()-interval '24 hours' AND statement_timestamp()
              ELSE FALSE END
          ORDER BY (i.presentation_json->>'parametersObservedAt')::timestamptz DESC,i.instance_id LIMIT 1) parameter_catalog ON TRUE
        LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('instanceId',live.instance_id,'channelId',live.channel_id,
            'channelInstanceId',live.channel_instance_id::text,'since',live.created_at,'working',live.status='busy')
            ORDER BY live.created_at,live.instance_id) AS instances
          FROM (SELECT i.instance_id,i.channel_id,i.channel_instance_id,i.status,run.created_at
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
        WHERE r.space_id=$1 AND ($7::boolean OR r.owner_user_id=$2 OR (m.user_id IS NOT NULL AND a.grant_state='active'))
          AND ($3::text IS NULL OR (r.owner_user_id,r.machine_id,r.harness)>($3,$4,$5))
        ORDER BY r.owner_user_id,r.machine_id,r.harness LIMIT $6`,
      values: [input.spaceId, input.actorUserId, ...(cursor ?? [null, null, null]), limit + 1, admin], maxRows: limit + 1 });
      const current = rows.slice(0, limit), last = current.at(-1);
      const registrations: AgentRegistrationSummary[] = current.map(row => {
        const key = parseSpaceAgentRegistrationKey({ spaceId: input.spaceId, ownerUserId: row.owner_user_id,
          machineId: row.machine_id, harness: row.harness });
        const configuration = parseSpaceAgentConfiguration(row.configuration_json);
        const allowed = row.grant_limits && row.policy_limits ? intersectRegistrationLimits(
          parseRegistrationResourceLimits(row.grant_limits), parseRegistrationResourceLimits(row.policy_limits)) : null;
        const models = [...new Set([...(configuration.model ? [configuration.model] : []), ...(configuration.routing?.models ?? [])])]
          .filter(model => allowed?.models.includes(model)).sort();
        // An empty model list allows only the runtime default, so no observed
        // model is offered for it. No fresh observation stays absent.
        const parameterObservation = harnessParameterObservation(row.catalog_parameters, row.parameters_observed_at,
          row.parameter_model, models, Date.now());
        return { ...parameterObservation,
          key, displayName: String(row.display_name), version: Number(row.version),
          modelCatalog: routingModelCatalogObservation(row.catalog_models, row.catalog_observed_at, Date.now())?.value
            .filter(model => models.includes(model.model)),
          ownerName: String(row.owner_name || "Space member"), machineName: "Registered machine", models,
          routingReady: row.current_owner !== null && row.grant_state === "active" && row.policy_state === "enabled" &&
            configuration.routing?.enabled === true && (configuration.routing.models.length === 0 ||
              configuration.routing.models.some(model => models.includes(model))),
          state: !row.current_owner ? "revoked" : !row.grant_state ? "unshared"
            : row.grant_state === "revoked" ? "revoked" : spaceState(row.policy_state),
          canManageOwnerGrant: input.actorUserId === key.ownerUserId, canConfigureSpace: admin,
          canRemoveFromSpace: admin || input.actorUserId === key.ownerUserId,
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
    const labels = await this.database.transaction({ requestId: input.requestId, operation: "registration.machine-labels" },
      tx => tx.query({ name: "registration_catalog_machine_labels_v9", text: `SELECT
        requested.owner,requested.machine,requested.harness,machine.name,
        e.declaration_json,daemon.online,daemon.last_seen_at,daemon.resources,daemon.platform,
        quota.remaining,quota.observed_at,quota.expires_at,quota.windows_json,quota.account_json
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
            FILTER (WHERE metadata_json->>'platform' IS NOT NULL))[1] AS platform
          FROM data.machine_daemons WHERE owner_user_id=requested.owner AND machine_id=requested.machine) daemon ON TRUE
        ${currentRegistrationQuotaJoin("quota")}`,
      values: [JSON.stringify(page.registrations.map(row => ({ owner: row.key.ownerUserId,
        machine: row.key.machineId, harness: row.key.harness })))], maxRows: limit }));
    return { ...page, registrations: page.registrations.map(row => {
      const label = labels.find(label => label.owner === row.key.ownerUserId && label.machine === row.key.machineId && label.harness === row.key.harness);
      const environment = label?.declaration_json ? parseAgentRegistrationEnvironment(label.declaration_json) : null;
      // The physical environment bounds the Space's models exactly as a launch does.
      const models = row.models.filter(model => environment?.models.includes(model));
      const reported = row.modelCatalog?.filter(model => models.includes(model.model));
      const blocker: AgentRegistrationSummary["routingBlocker"] = !environment ? "owner_environment_missing"
        : !environment.enabled ? "owner_environment_disabled" : !row.routingReady ? "space_setup"
          : row.models.length && !models.length ? "model_unavailable" : undefined;
      const lastSeenAt = isoTime(label?.last_seen_at);
      const resources = label?.online === true ? machineResourceObservation(label.resources, Date.now()) : undefined;
      const platform = machinePlatform(label?.platform);
      const reading = registrationQuotaReading(label);
      const windows = currentRoutingQuotaWindows(label?.windows_json, Date.now());
      const account = parseLlmQuotaAccount(label?.account_json);
      // A provider account's headroom is its owner's; the Space's owners and admins manage its use.
      const quota = (row.canConfigureSpace || row.canManageOwnerGrant) && reading
        ? { ...reading, ...(windows.length ? { windows } : {}), ...(account ? { account } : {}) } : undefined;
      return { ...row, models, modelCatalog: reported, routingReady: !blocker, ...(blocker ? { routingBlocker: blocker } : {}),
        machineName: String(label?.name || row.machineName),
        live: { machine: { online: label?.online === true, ...(lastSeenAt ? { lastSeenAt } : {}),
          ...(resources ? { resources } : {}), ...(platform ? { platform } : {}) },
          running: row.live?.running ?? [], ...(quota ? { quota } : {}) } };
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
