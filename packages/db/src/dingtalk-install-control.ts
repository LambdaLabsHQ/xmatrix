import { lowercaseHex, sha256Hex } from "@xmatrix/protocol";
import { appRequestText as text } from "./app-request-text.js";
import { dingtalkVisible, dingtalkSelectedVisible } from "./dingtalk-visibility-control.js";
import { dingtalkAppIdentity, type DingTalkAppIdentity } from "./dingtalk-suite-control.js";
import {
  dingtalkAdmin,
  dingtalkPrimary,
  dingtalkCompanyDigest,
  dingtalkCompanyLock,
  dingtalkDecrypt,
  dingtalkDenied,
  dingtalkEncrypt,
  dingtalkGrant,
  dingtalkMaintain,
  dingtalkSelection,
  type DingTalkCompanyGrant,
  type DingTalkCompanySelection,
} from "./dingtalk-company-values.js";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";

type Request = {
  requestId: string;
  app: DingTalkAppIdentity;
  actorUserId: string;
};
type AttemptRequest = Request & { state: string };
const TABLE = "data.app_dingtalk_company_attempts";
async function stateDigest(state: string) {
  if (!/^[a-f0-9]{64}$/u.test(state)) dingtalkDenied();
  return sha256Hex(state);
}
async function connection(tx: DatabaseTransaction, id: string) {
  const rows = await tx.query<QueryResultRow>({
    name: "dingtalk_consent_connection_v1",
    text: `SELECT c.*,
    COALESCE((SELECT version FROM data.app_connector_credentials k WHERE k.connection_id=c.connection_id),0) AS credential_version
    FROM data.app_connector_connections c WHERE connection_id=$1 AND provider_id='dingtalk' FOR UPDATE`,
    values: [id],
    maxRows: 1,
  });
  if (!rows[0]) dingtalkDenied();
  return rows[0];
}
function unchanged(row: QueryResultRow, attempt: QueryResultRow) {
  if (
    Number(row.version) !== Number(attempt.connection_version) ||
    Number(row.credential_version) !== Number(attempt.credential_version) ||
    row.search_rank_sequence !== attempt.connection_generation ||
    row.space_id !== attempt.space_id
  )
    dingtalkDenied();
}
/** Consent states are secrets, not bearer access to a Space: every operation authenticates the original Human again. */
export class PostgresDingTalkInstallRepository {
  constructor(
    private readonly database: AuthorityDatabase,
    private readonly key: string,
  ) {
    dingtalkPrimary(database, key);
  }
  private async attempt(tx: DatabaseTransaction, input: AttemptRequest, phase: string) {
    const identity = dingtalkAppIdentity(input.app),
      digest = await stateDigest(input.state),
      actor = text(input.actorUserId, "actorUserId");
    const targets = await tx.query<QueryResultRow>({
      name: "dingtalk_attempt_target_v1",
      text: `SELECT connection_id,company_digest FROM ${TABLE}
      WHERE state_digest=$1 AND app_identity=$2 AND actor_user_id=$3 LIMIT 1`,
      values: [digest, identity, actor],
      maxRows: 1,
    });
    if (!targets[0]) dingtalkDenied();
    await dingtalkCompanyLock(tx, identity, String(targets[0].company_digest));
    const captured = await connection(tx, String(targets[0].connection_id));
    const rows = await tx.query<QueryResultRow>({
      name: "dingtalk_attempt_current_v1",
      text: `SELECT a.* FROM ${TABLE} a
      WHERE state_digest=$1 AND app_identity=$2 AND actor_user_id=$3 AND phase=$4 AND expires_at>clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM data.app_dingtalk_company_fences f WHERE f.app_identity=a.app_identity
          AND f.company_digest=a.company_digest AND f.changed_at>=a.started_at) FOR UPDATE`,
      values: [digest, identity, actor, phase],
      maxRows: 1,
    });
    if (!rows[0]) dingtalkDenied();
    unchanged(captured, rows[0]);
    if ((await dingtalkAdmin(tx, String(rows[0].space_id), actor)) !== String(rows[0].actor_membership_generation))
      dingtalkDenied();
    return { row: rows[0], captured };
  }
  async begin(input: Request & { spaceId: string; selection: DingTalkCompanySelection }) {
    const selection = dingtalkSelection(input.selection),
      identity = dingtalkAppIdentity(input.app),
      spaceId = text(input.spaceId, "spaceId");
    const actor = text(input.actorUserId, "actorUserId"),
      company = await dingtalkCompanyDigest(input.app, selection.corpId);
    const state = lowercaseHex(crypto.getRandomValues(new Uint8Array(32))),
      digest = await stateDigest(state);
    await this.database.transaction(
      {
        requestId: text(input.requestId, "requestId", 200),
        operation: "app.dingtalk.consent-begin",
      },
      async (tx) => {
        await dingtalkCompanyLock(tx, identity, company);
        await dingtalkMaintain(tx);
        const captured = await connection(tx, `${spaceId}:dingtalk`);
        const membershipVersion = await dingtalkAdmin(tx, spaceId, actor);
        const capacity = await tx.query<QueryResultRow>({
          name: "dingtalk_attempt_capacity_v1",
          text: `SELECT count(*) AS n FROM
        (SELECT 1 FROM ${TABLE} WHERE app_identity=$1 AND company_digest=$2 AND connection_id<>$3 LIMIT 50) bounded`,
          values: [identity, company, captured.connection_id],
          maxRows: 1,
        });
        if (Number(capacity[0]?.n) >= 50) dingtalkDenied();
        const row = {
          state_digest: digest,
          connection_id: captured.connection_id,
          space_id: spaceId,
          app_identity: identity,
          company_digest: company,
          actor_user_id: actor,
          actor_membership_generation: membershipVersion,
          connection_version: captured.version,
          credential_version: captured.credential_version,
          connection_generation: captured.search_rank_sequence,
          phase: "started",
        };
        const encrypted = await dingtalkEncrypt(this.key, row, true, selection);
        await tx.query({
          name: "dingtalk_attempt_replace_v1",
          text: `DELETE FROM ${TABLE} WHERE connection_id=$1`,
          values: [captured.connection_id],
          maxRows: 0,
        });
        await tx.query({
          name: "dingtalk_attempt_insert_v1",
          text: `INSERT INTO ${TABLE}
        (state_digest,connection_id,space_id,app_identity,company_digest,actor_user_id,connection_version,credential_version,connection_generation,encrypted_value_json,actor_membership_generation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
          values: [
            digest,
            captured.connection_id,
            spaceId,
            identity,
            company,
            actor,
            captured.version,
            captured.credential_version,
            captured.search_rank_sequence,
            JSON.stringify(encrypted),
            membershipVersion,
          ],
          maxRows: 0,
        });
      },
    );
    return { state };
  }
  /** Consume before outbound evidence requests. Losing an HTTP response cannot replay native consent. */
  async take(input: AttemptRequest & { corpId?: string }) {
    return this.database.transaction(
      {
        requestId: text(input.requestId, "requestId", 200),
        operation: "app.dingtalk.consent-take",
      },
      async (tx) => {
        const { row } = await this.attempt(tx, input, "started");
        const selected = dingtalkSelection((await dingtalkDecrypt(this.key, row, true)) as DingTalkCompanySelection);
        if (input.corpId !== undefined && selected.corpId !== input.corpId) dingtalkDenied();
        const encrypted = await dingtalkEncrypt(this.key, { ...row, phase: "taken" }, true, selected);
        await tx.query({
          name: "dingtalk_consent_spend_v1",
          text: `UPDATE ${TABLE} SET phase='taken',encrypted_value_json=$2::jsonb
        WHERE state_digest=$1`,
          values: [row.state_digest, JSON.stringify(encrypted)],
          maxRows: 0,
        });
        return { spaceId: String(row.space_id), selection: selected };
      },
    );
  }
  async verify(input: AttemptRequest & { grant: DingTalkCompanyGrant }) {
    const grant = dingtalkGrant(input.grant);
    await this.database.transaction(
      {
        requestId: text(input.requestId, "requestId", 200),
        operation: "app.dingtalk.consent-verify",
      },
      async (tx) => {
        const { row } = await this.attempt(tx, input, "taken"),
          selected = dingtalkSelection((await dingtalkDecrypt(this.key, row, true)) as DingTalkCompanySelection);
        if (JSON.stringify(selected) !== JSON.stringify(dingtalkSelection(grant))) dingtalkDenied();
        await dingtalkVisible(tx, this.key, input.app, grant);
        const encrypted = await dingtalkEncrypt(this.key, { ...row, phase: "verified" }, true, grant);
        await tx.query({
          name: "dingtalk_consent_verified_v1",
          text: `UPDATE ${TABLE} SET phase='verified',encrypted_value_json=$2::jsonb
        WHERE state_digest=$1`,
          values: [row.state_digest, JSON.stringify(encrypted)],
          maxRows: 0,
        });
      },
    );
  }
  /** Every outbound private read rechecks original consent and full signed visibility first. */
  async taken(input: AttemptRequest) {
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.dingtalk.consent-current-taken" }, async tx => {
      const { row } = await this.attempt(tx, input, "taken");
      const selection = dingtalkSelection(await dingtalkDecrypt(this.key, row, true) as DingTalkCompanySelection);
      return { spaceId: String(row.space_id), ...await dingtalkSelectedVisible(tx, this.key, input.app, selection) };
    });
  }
  async prepared(input: AttemptRequest) {
    return this.database.transaction(
      {
        requestId: text(input.requestId, "requestId", 200),
        operation: "app.dingtalk.consent-prepared",
      },
      async (tx) => {
        const { row } = await this.attempt(tx, input, "verified");
        const grant = dingtalkGrant((await dingtalkDecrypt(this.key, row, true)) as DingTalkCompanyGrant);
        return {
          spaceId: String(row.space_id),
          grant,
          scopeVersion: await dingtalkVisible(tx, this.key, input.app, grant),
        };
      },
    );
  }
  async confirm(input: AttemptRequest & { spaceId: string; confirmed: true }) {
    if (input.confirmed !== true) dingtalkDenied();
    await this.database.transaction(
      {
        requestId: text(input.requestId, "requestId", 200),
        operation: "app.dingtalk.consent-confirm",
      },
      async (tx) => {
        const { row, captured } = await this.attempt(tx, input, "verified");
        if (row.space_id !== input.spaceId) dingtalkDenied();
        const grant = dingtalkGrant((await dingtalkDecrypt(this.key, row, true)) as DingTalkCompanyGrant);
        const visibility = await dingtalkVisible(tx, this.key, input.app, grant);
        const count = await tx.query<QueryResultRow>({
          name: "dingtalk_grant_capacity_v1",
          text: `SELECT count(*) AS n FROM
        (SELECT 1 FROM data.app_dingtalk_company_grants WHERE app_identity=$1 AND company_digest=$2 AND connection_id<>$3 LIMIT 50) bounded`,
          values: [row.app_identity, row.company_digest, row.connection_id],
          maxRows: 1,
        });
        if (Number(count[0]?.n) >= 50) dingtalkDenied();
        const previous = await tx.query<QueryResultRow>({
          name: "dingtalk_grant_version_v1",
          text: `SELECT version FROM data.app_dingtalk_company_grants
        WHERE connection_id=$1 FOR UPDATE`,
          values: [row.connection_id],
          maxRows: 1,
        });
        const installed = {
          ...row,
          version: Number(previous[0]?.version ?? 0) + 1,
          grant_generation: crypto.randomUUID(),
          visibility_version: visibility,
        };
        const encrypted = await dingtalkEncrypt(this.key, installed, false, grant);
        await tx.query({
          name: "dingtalk_grant_confirm_v1",
          text: `INSERT INTO data.app_dingtalk_company_grants
        (connection_id,space_id,app_identity,company_digest,actor_user_id,connection_generation,grant_generation,version,encrypted_value_json,started_at,visibility_version,actor_membership_generation)
        VALUES ($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9::jsonb,$10,$11,$12) ON CONFLICT(connection_id) DO UPDATE SET
          app_identity=EXCLUDED.app_identity,company_digest=EXCLUDED.company_digest,actor_user_id=EXCLUDED.actor_user_id,
          connection_generation=EXCLUDED.connection_generation,grant_generation=EXCLUDED.grant_generation,version=EXCLUDED.version,
          encrypted_value_json=EXCLUDED.encrypted_value_json,started_at=EXCLUDED.started_at,visibility_version=EXCLUDED.visibility_version,
          actor_membership_generation=EXCLUDED.actor_membership_generation,confirmed_at=statement_timestamp()`,
          values: [
            row.connection_id,
            row.space_id,
            row.app_identity,
            row.company_digest,
            row.actor_user_id,
            captured.search_rank_sequence,
            installed.grant_generation,
            installed.version,
            JSON.stringify(encrypted),
            row.started_at,
            visibility,
            row.actor_membership_generation,
          ],
          maxRows: 0,
        });
        await tx.query({
          name: "dingtalk_manual_retire_v1",
          text: "DELETE FROM data.app_connector_credentials WHERE connection_id=$1",
          values: [row.connection_id],
          maxRows: 0,
        });
        await tx.query({
          name: "dingtalk_connection_confirm_v1",
          text: `UPDATE data.app_connector_connections SET status='configured',error=NULL,
        version=version+1,last_checked_at=statement_timestamp(),updated_at=statement_timestamp() WHERE connection_id=$1`,
          values: [row.connection_id],
          maxRows: 0,
        });
        await tx.query({
          name: "dingtalk_attempt_consume_v1",
          text: `DELETE FROM ${TABLE} WHERE state_digest=$1`,
          values: [row.state_digest],
          maxRows: 0,
        });
      },
    );
  }
}
