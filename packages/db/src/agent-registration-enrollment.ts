import type { SpaceAgentRegistrationKey } from "@xmatrix/protocol";
import type { AuthorityDatabase } from "./contracts.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";

/** The owning human and current Space creation policy have been checked before
 * this call. Enrollment is global; sharing/configuration is a separate Space
 * fact and may fail independently without granting execution authority. */
export async function enrollGlobalRegistration(database: AuthorityDatabase, input: {
  key: SpaceAgentRegistrationKey; commandId: string; requestDigest: string;
}) {
  const { key } = input;
  return database.transaction({ requestId: input.commandId, operation: "registration.enroll.global" }, async tx => {
    const machine = await tx.query({ name: "registration_enrollment_machine_v1", text: `SELECT daemon_id
      FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2 ORDER BY daemon_id LIMIT 1 FOR SHARE`,
    values: [key.ownerUserId, key.machineId], maxRows: 1 });
    if (!machine[0]) throw new RegistrationAccessError("registration_machine_not_owned", 403);
    await tx.query({ name: "registration_enrollment_command_lock_v1", text: `SELECT pg_advisory_xact_lock(
      hashtextextended(jsonb_build_array('registration-enrollment',$1::text,$2::text)::text,0))`,
    values: [key.ownerUserId, input.commandId], maxRows: 1 });
    const replay = await tx.query({ name: "registration_enrollment_replay_v1", text: `SELECT request_digest
      FROM control.agent_registration_enrollments WHERE owner_user_id=$1 AND command_id=$2`,
    values: [key.ownerUserId, input.commandId], maxRows: 1 });
    if (replay[0] && replay[0].request_digest !== input.requestDigest) {
      throw new RegistrationAccessError("idempotency_mismatch", 409);
    }
    if (!replay[0]) {
      await tx.query({ name: "registration_enroll_tuple_v1", text: `INSERT INTO data.agent_registrations
        (owner_user_id,machine_id,harness,version,created_at,updated_at)
        VALUES ($1,$2,$3,1,clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING`,
      values: [key.ownerUserId, key.machineId, key.harness], maxRows: 0 });
      await tx.query({ name: "registration_enrollment_record_v1", text: `INSERT INTO control.agent_registration_enrollments
        (owner_user_id,command_id,space_id,machine_id,harness,request_digest) VALUES ($1,$2,$3,$4,$5,$6)`,
      values: [key.ownerUserId, input.commandId, key.spaceId, key.machineId, key.harness, input.requestDigest], maxRows: 0 });
    }
    const rows = await tx.query({ name: "registration_enrollment_snapshot_v1", text: `SELECT version,created_at,updated_at
      FROM data.agent_registrations WHERE owner_user_id=$1 AND machine_id=$2 AND harness=$3 FOR SHARE`,
    values: [key.ownerUserId, key.machineId, key.harness], maxRows: 1 });
    if (!rows[0]) throw new RegistrationAccessError("registration_enrollment_missing", 409);
    return { version: Number(rows[0].version), createdAt: rows[0].created_at, updatedAt: rows[0].updated_at };
  });
}
