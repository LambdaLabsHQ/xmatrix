import { registrationKeyFromRow } from "./agent-registration-rows.js";
import { digestCanonicalCloneCborV1, parseAgentEnvironmentCommand, parseAgentRegistrationEnvironment,
  parseAgentRegistrationKey, type AgentEnvironmentCommand, type AgentRegistrationKey } from "@xmatrix/protocol";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";

async function owner(tx: DatabaseTransaction, actorUserId: string, key: AgentRegistrationKey) {
  if (actorUserId !== key.ownerUserId) throw new RegistrationAccessError("registration_not_found", 404);
  const rows = await tx.query({ name: "registration_environment_owner_v1", text: `SELECT r.owner_user_id
    FROM data.agent_registrations r WHERE r.owner_user_id=$1 AND r.machine_id=$2 AND r.harness=$3
      AND EXISTS (SELECT 1 FROM data.machine_daemons d WHERE d.owner_user_id=r.owner_user_id AND d.machine_id=r.machine_id)
    FOR SHARE`, values: [key.ownerUserId, key.machineId, key.harness], maxRows: 1 });
  if (!rows[0]) throw new RegistrationAccessError("registration_not_found", 404);
}

/** Physical environment declarations have exactly one
 * writer: the authenticated machine owner, on the global directory connection.
 * Updating these declarations does not install software or grant Space access. */
export class PostgresAgentEnvironmentRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new RegistrationAccessError("cached_authority_forbidden", 500);
  }

  async get(input: { key: AgentRegistrationKey; actorUserId: string; requestId: string }) {
    const key = parseAgentRegistrationKey(input.key);
    return this.database.transaction({ requestId: input.requestId, operation: "registration.environment.get" }, async tx => {
      await owner(tx, input.actorUserId, key);
      const rows = await tx.query({ name: "registration_environment_read_v1", text: `SELECT declaration_json,version
        FROM control.agent_registration_environments WHERE owner_user_id=$1 AND machine_id=$2 AND harness=$3`,
      values: [key.ownerUserId, key.machineId, key.harness], maxRows: 1 });
      return { key, version: Number(rows[0]?.version ?? 0), environment: rows[0]
        ? parseAgentRegistrationEnvironment(rows[0].declaration_json) : null };
    });
  }

  /** Of these registrations, the ones their owner turned off on the machine or
   * whose Machine the owner removed.
   * Internal: the Channel coordinator stops their Runs; no public route. */
  async disabled(input: { keys: readonly AgentRegistrationKey[]; requestId: string }): Promise<AgentRegistrationKey[]> {
    if (!input.keys.length) return [];
    const keys = input.keys.slice(0, 50).map(parseAgentRegistrationKey);
    const rows = await this.database.transaction({ requestId: input.requestId, operation: "registration.environment.disabled" },
      tx => tx.query({ name: "registration_environment_disabled_v2", text: `SELECT k.owner AS owner_user_id,
        k.machine AS machine_id,k.harness
        FROM jsonb_to_recordset($1::jsonb) AS k(owner text,machine text,harness text)
        WHERE EXISTS (SELECT 1 FROM control.agent_registration_environments e
          WHERE e.owner_user_id=k.owner AND e.machine_id=k.machine AND e.harness=k.harness
            AND e.declaration_json->'enabled' IS DISTINCT FROM 'true'::jsonb)
        OR EXISTS (SELECT 1 FROM data.machines m
          WHERE m.owner_user_id=k.owner AND m.machine_id=k.machine AND m.retired_at IS NOT NULL)`,
      values: [JSON.stringify(keys.map(key => ({ owner: key.ownerUserId, machine: key.machineId, harness: key.harness })))],
      maxRows: 50 }));
    return rows.map(registrationKeyFromRow);
  }

  async change(raw: AgentEnvironmentCommand & { actorUserId: string }) {
    const { actorUserId, ...command } = raw;
    const input = parseAgentEnvironmentCommand(command), { key } = input;
    const digest = await digestCanonicalCloneCborV1(input);
    return this.database.transaction({ requestId: input.commandId, operation: "registration.environment.change" }, async tx => {
      await owner(tx, actorUserId, key);
      await tx.query({ name: "registration_environment_replay_lock_v1", text: `SELECT pg_advisory_xact_lock(
        hashtextextended(jsonb_build_array('registration-environment-command',$1::text,$2::text)::text,0))`,
      values: [actorUserId, input.commandId], maxRows: 1 });
      const replay = await tx.query({ name: "registration_environment_replay_v1", text: `SELECT
        request_digest,result_version,result_machine_version FROM control.agent_environment_commands
        WHERE actor_user_id=$1 AND command_id=$2`, values: [actorUserId, input.commandId], maxRows: 1 });
      if (replay[0]) {
        if (replay[0].request_digest !== digest) throw new RegistrationAccessError("idempotency_mismatch", 409);
        return { key, version: Number(replay[0].result_version), reused: true };
      }
      await tx.query({ name: "registration_environment_key_lock_v1", text: `SELECT pg_advisory_xact_lock(
        hashtextextended(jsonb_build_array('registration-environment',$1::text,$2::text,$3::text)::text,0))`,
        values: [key.ownerUserId,key.machineId,key.harness], maxRows: 1 });
      const rows = await tx.query({ name: "registration_environment_lock_v1", text: `SELECT version
        FROM control.agent_registration_environments WHERE owner_user_id=$1 AND machine_id=$2 AND harness=$3 FOR UPDATE`,
      values: [key.ownerUserId, key.machineId, key.harness], maxRows: 1 });
      if (Number(rows[0]?.version ?? 0) !== input.expectedVersion) throw new RegistrationAccessError("environment_version_conflict", 409);
      const version = input.expectedVersion + 1;
      // Compatibility storage only: the historical environment FK still needs
      // this row until a contract migration removes it. No reader uses its limit
      // for admission, selection or execution; no product API exposes it.
      await tx.query({ name: "registration_environment_legacy_fk_v1", text: `INSERT INTO control.machine_execution_capacity
        (owner_user_id,machine_id,max_concurrent,version) VALUES ($1,$2,1,1)
        ON CONFLICT (owner_user_id,machine_id) DO NOTHING`,
        values: [key.ownerUserId,key.machineId], maxRows: 0 });
      await tx.query({ name: "registration_environment_write_v1", text: `INSERT INTO control.agent_registration_environments
        (owner_user_id,machine_id,harness,declaration_json,version) VALUES ($1,$2,$3,$4::jsonb,$5)
        ON CONFLICT (owner_user_id,machine_id,harness) DO UPDATE SET declaration_json=EXCLUDED.declaration_json,
          version=EXCLUDED.version,updated_at=clock_timestamp()`,
      values: [key.ownerUserId, key.machineId, key.harness, JSON.stringify(input.environment), version], maxRows: 0 });
      await tx.query({ name: "registration_environment_command_record_v1", text: `INSERT INTO control.agent_environment_commands
        (actor_user_id,command_id,owner_user_id,machine_id,harness,request_digest,result_version,result_machine_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, values: [actorUserId, input.commandId, key.ownerUserId,
        key.machineId, key.harness, digest, version, 1], maxRows: 0 });
      return { key, version, reused: false };
    });
  }
}
