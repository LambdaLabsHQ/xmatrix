import { sha256Hex } from "@xmatrix/protocol";
import { dingtalkAppIdentity, type DingTalkAppIdentity } from "./dingtalk-suite-control.js";
import { appRequestText as text } from "./app-request-text.js";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { dingtalkPrimary, dingtalkCompanyDigest, dingtalkDenied } from "./dingtalk-company-values.js";
import { encryptSecretValue, decryptSecretValue } from "./secret-value-control.js";

type Request = { requestId: string; app: DingTalkAppIdentity; kind: "suite" | "corp"; corpId?: string; ticketVersion: number };
export type DingTalkTokenLease = { leaseId: string; generation: string };
const TABLE = "data.app_dingtalk_company_tokens";
function owner(row: QueryResultRow) {
  return JSON.stringify(["dingtalk-suite-ticket-token", row.app_identity, row.company_digest,
    row.token_kind, String(row.ticket_version), row.token_generation, String(row.expires_epoch)]);
}
/** Provider-confirmed expireIn only; no assumed ticket lifetime and no client_credentials fallback. */
export class PostgresDingTalkTokenRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly material: string) {
    dingtalkPrimary(database, material);
  }
  private async key(input: Request) {
    const identity = dingtalkAppIdentity(input.app);
    if (!["suite", "corp"].includes(input.kind) || !Number.isSafeInteger(input.ticketVersion) || input.ticketVersion < 1 ||
        (input.kind === "suite" ? input.corpId !== undefined : typeof input.corpId !== "string")) dingtalkDenied();
    const company = input.kind === "suite" ? await sha256Hex(JSON.stringify([identity, "suite-token"])) :
      await dingtalkCompanyDigest(input.app, input.corpId!);
    return [identity, company, input.kind] as const;
  }
  private async ticket(tx: DatabaseTransaction, identity: string, version: number) {
    const rows = await tx.query({ name: "dingtalk_token_current_ticket_v1", text: `SELECT 1
      FROM data.app_dingtalk_suite_tickets WHERE app_identity=$1 AND version=$2 AND NOT ambiguous
        AND event_time<=clock_timestamp()+interval '30 seconds' FOR SHARE`, values: [identity, version], maxRows: 1 });
    if (!rows.length) dingtalkDenied();
  }
  async acquire(input: Request): Promise<{ value: string } | DingTalkTokenLease> {
    const values = await this.key(input);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.dingtalk.token-acquire" }, async tx => {
      await tx.query({ name: "dingtalk_token_capacity_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended('dingtalk-tokens',0))", values: [], maxRows: 1 });
      await this.ticket(tx, values[0], input.ticketVersion);
      const rows = await tx.query<QueryResultRow>({ name: "dingtalk_token_read_v1", text: `SELECT *,
        expires_epoch>floor(extract(epoch from clock_timestamp()))::bigint AS valid,
        lease_until>clock_timestamp() AS leased FROM ${TABLE}
        WHERE app_identity=$1 AND company_digest=$2 AND token_kind=$3 FOR UPDATE`, values, maxRows: 1 });
      const row = rows[0];
      if (row && Number(row.ticket_version) === input.ticketVersion) {
        if (row.valid) {
          const value = await decryptSecretValue(this.material, { owner_user_id: owner(row), secret_ref: "token",
            authority_version: 1, encrypted_value_json: row.encrypted_value_json });
          if (!/^[A-Za-z0-9_.-]{8,512}$/u.test(value)) dingtalkDenied();
          return { value };
        }
        if (row.leased) throw new AppControlError("dingtalk_token_refresh_busy", 503, "DingTalk token refresh is in progress", true);
      }
      await tx.query({ name: "dingtalk_token_cleanup_v1", text: `DELETE FROM ${TABLE} WHERE (app_identity,company_digest,token_kind) IN
        (SELECT app_identity,company_digest,token_kind FROM ${TABLE}
          WHERE expires_epoch<=floor(extract(epoch from clock_timestamp()))::bigint AND (lease_until IS NULL OR lease_until<=clock_timestamp())
          ORDER BY expires_epoch LIMIT 64 FOR UPDATE SKIP LOCKED)`, values: [], maxRows: 0 });
      const capacity = await tx.query<QueryResultRow>({ name: "dingtalk_token_capacity_v1", text: `SELECT count(*) AS n FROM
        (SELECT 1 FROM ${TABLE} LIMIT 10000) bounded`, values: [], maxRows: 1 });
      if (!row && Number(capacity[0]?.n) >= 10000) throw new AppControlError("dingtalk_token_capacity", 503, "DingTalk token capacity reached", true);
      const leaseId = crypto.randomUUID(), generation = crypto.randomUUID();
      await tx.query({ name: "dingtalk_token_lease_v1", text: `INSERT INTO ${TABLE}
        (app_identity,company_digest,token_kind,ticket_version,token_generation,lease_id,lease_until)
        VALUES ($1,$2,$3,$4,$5::uuid,$6::uuid,clock_timestamp()+interval '15 seconds')
        ON CONFLICT(app_identity,company_digest,token_kind) DO UPDATE SET ticket_version=EXCLUDED.ticket_version,
          token_generation=EXCLUDED.token_generation,lease_id=EXCLUDED.lease_id,lease_until=EXCLUDED.lease_until,
          expires_epoch=0,encrypted_value_json='{}'::jsonb,updated_at=clock_timestamp()`,
      values: [...values, input.ticketVersion, generation, leaseId], maxRows: 0 });
      return { leaseId, generation };
    });
  }
  async save(input: Request & DingTalkTokenLease & { value: string; expireIn: number }) {
    const values = await this.key(input);
    if (!/^[A-Za-z0-9_.-]{8,512}$/u.test(input.value) || !Number.isSafeInteger(input.expireIn) || input.expireIn <= 30 || input.expireIn > 7200 ||
        !/^[a-f0-9-]{36}$/u.test(input.leaseId) || !/^[a-f0-9-]{36}$/u.test(input.generation)) dingtalkDenied();
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.dingtalk.token-save" }, async tx => {
      await this.ticket(tx, values[0], input.ticketVersion);
      const rows = await tx.query<QueryResultRow>({ name: "dingtalk_token_save_target_v1", text: `SELECT *,
        floor(extract(epoch from clock_timestamp()))::bigint+$7::bigint-30 AS next_expiry FROM ${TABLE}
        WHERE app_identity=$1 AND company_digest=$2 AND token_kind=$3 AND ticket_version=$4
          AND token_generation=$5::uuid AND lease_id=$6::uuid AND lease_until>clock_timestamp() FOR UPDATE`,
      values: [...values, input.ticketVersion, input.generation, input.leaseId, input.expireIn], maxRows: 1 });
      if (!rows[0]) dingtalkDenied();
      const row = { ...rows[0], expires_epoch: rows[0].next_expiry };
      const envelope = await encryptSecretValue(this.material, owner(row), "token", 1, input.value);
      await tx.query({ name: "dingtalk_token_save_v1", text: `UPDATE ${TABLE} SET expires_epoch=$4,encrypted_value_json=$5::jsonb,
        lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE app_identity=$1 AND company_digest=$2 AND token_kind=$3`, values: [...values, row.expires_epoch, JSON.stringify(envelope)], maxRows: 0 });
    });
  }
}
