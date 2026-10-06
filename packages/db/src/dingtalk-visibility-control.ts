import { sha256Hex } from "@xmatrix/protocol";
import { appRequestText as text } from "./app-request-text.js";
import { appTicketEventTime } from "./app-ticket-control.js";
import { decryptSecretValue, encryptSecretValue } from "./secret-value-control.js";
import { dingtalkAppIdentity, type DingTalkAppIdentity } from "./dingtalk-suite-control.js";
import {
  dingtalkPrimary,
  dingtalkCompanyDigest,
  dingtalkCompanyLock,
  dingtalkDenied,
  DINGTALK_MEMBER,
  dingtalkSelection,
  type DingTalkCompanySelection,
  type DingTalkCompanyGrant,
} from "./dingtalk-company-values.js";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";

export interface DingTalkVisibleScope {
  corpId: string;
  appId: number;
  agentId: number;
  users: string[];
  departments: string[];
}
function scope(value: DingTalkVisibleScope) {
  if (
    !value ||
    !Number.isSafeInteger(value.appId) ||
    value.appId < 1 ||
    !Number.isSafeInteger(value.agentId) ||
    value.agentId < 1 ||
    !Array.isArray(value.users) ||
    value.users.length > 1000 ||
    value.users.some(
      (user) => typeof user !== "string" || !DINGTALK_MEMBER.test(user) || user.toLowerCase() === "@all",
    ) ||
    !Array.isArray(value.departments) ||
    value.departments.length > 1000 ||
    value.departments.some((dept) => typeof dept !== "string" || !/^[1-9][0-9]{0,15}$/u.test(dept)) ||
    new Set(value.users).size !== value.users.length ||
    new Set(value.departments).size !== value.departments.length ||
    Object.keys(value).some((key) => !["corpId", "appId", "agentId", "users", "departments"].includes(key))
  )
    dingtalkDenied();
  return {
    ...value,
    users: [...value.users].sort(),
    departments: [...value.departments].sort(),
  };
}
const owner = (row: QueryResultRow) =>
  JSON.stringify(["dingtalk-visibility", row.app_identity, row.company_digest, String(row.app_id)]);
async function decode(key: string, row: QueryResultRow) {
  if (row.ambiguous) dingtalkDenied();
  return scope(
    JSON.parse(
      await decryptSecretValue(key, {
        owner_user_id: owner(row),
        secret_ref: "scope",
        authority_version: Number(row.version),
        encrypted_value_json: row.encrypted_value_json,
      }),
    ) as DingTalkVisibleScope,
  );
}
/** Installation and later effects require this exact primary snapshot; contact-read scopes never satisfy it. */
async function currentScope(tx: DatabaseTransaction, key: string, app: DingTalkAppIdentity, corpId: string, appId: number) {
  const identity = dingtalkAppIdentity(app),
    company = await dingtalkCompanyDigest(app, corpId);
  const rows = await tx.query<QueryResultRow>({
    name: "dingtalk_visible_scope_v1",
    text: `SELECT s.* FROM data.app_dingtalk_company_visibility s
    WHERE s.app_identity=$1 AND s.company_digest=$2 AND s.app_id=$3 AND NOT s.ambiguous
      AND NOT EXISTS (SELECT 1 FROM data.app_dingtalk_company_fences f WHERE f.app_identity=s.app_identity
        AND f.company_digest=s.company_digest AND f.changed_at>=s.event_time) LIMIT 1 FOR SHARE`,
    values: [identity, company, appId],
    maxRows: 1,
  });
  if (!rows[0]) dingtalkDenied();
  const visible = await decode(key, rows[0]);
  if (visible.corpId !== corpId || visible.appId !== appId) dingtalkDenied();
  return { visible, version: Number(rows[0].version) };
}
export async function dingtalkSelectedVisible(tx: DatabaseTransaction, key: string, app: DingTalkAppIdentity, input: DingTalkCompanySelection) {
  const selection = dingtalkSelection(input), { visible, version } = await currentScope(tx, key, app, selection.corpId, selection.appId);
  if (selection.members.some(member => !visible.users.includes(member))) dingtalkDenied();
  return { grant: { ...selection, agentId: visible.agentId }, scopeVersion: version };
}
export async function dingtalkVisible(tx: DatabaseTransaction, key: string, app: DingTalkAppIdentity, grant: DingTalkCompanyGrant) {
  const { visible, version } = await currentScope(tx, key, app, grant.corpId, grant.appId);
  if (
    visible.corpId !== grant.corpId ||
    visible.appId !== grant.appId ||
    visible.agentId !== grant.agentId ||
    grant.members.some((member) => !visible.users.includes(member))
  )
    dingtalkDenied();
  return version;
}
/** Trusted ingress only: callers must authenticate the encrypted SyncHTTP receiver and subscription before accepting a full biz7 snapshot. */
export class PostgresDingTalkVisibilityRepository {
  constructor(
    private readonly database: AuthorityDatabase,
    private readonly key: string,
  ) {
    dingtalkPrimary(database, key);
  }
  async accept(input: { requestId: string; app: DingTalkAppIdentity; eventTime: string; scope: DingTalkVisibleScope }) {
    const visible = scope(input.scope),
      identity = dingtalkAppIdentity(input.app),
      company = await dingtalkCompanyDigest(input.app, visible.corpId);
    const at = appTicketEventTime(input.eventTime),
      digest = await sha256Hex(JSON.stringify(visible));
    const result = await this.database.transaction(
      {
        requestId: text(input.requestId, "requestId", 200),
        operation: "app.dingtalk.visible-accept",
      },
      async (tx) => {
        await tx.query({
          name: "dingtalk_visibility_capacity_lock_v1",
          text: "SELECT pg_advisory_xact_lock(hashtextextended('dingtalk-visibility-capacity',0))",
          values: [],
          maxRows: 1,
        });
        await dingtalkCompanyLock(tx, identity, company);
        const rows = await tx.query<QueryResultRow>({
          name: "dingtalk_visible_lock_v1",
          text: `SELECT * FROM data.app_dingtalk_company_visibility
        WHERE app_identity=$1 AND company_digest=$2 AND app_id=$3 FOR UPDATE`,
          values: [identity, company, visible.appId],
          maxRows: 1,
        });
        const prior = rows[0],
          time = prior ? new Date(prior.event_time).getTime() : 0,
          incoming = Date.parse(at);
        if (!prior) {
          const capacity = await tx.query<QueryResultRow>({
            name: "dingtalk_visibility_capacity_v1",
            text: `SELECT
            (SELECT count(*) FROM (SELECT 1 FROM data.app_dingtalk_company_visibility LIMIT 10000) total) AS total,
            (SELECT count(*) FROM (SELECT 1 FROM data.app_dingtalk_company_visibility WHERE app_identity=$1 AND company_digest=$2 LIMIT 50) company) AS company`,
            values: [identity, company],
            maxRows: 1,
          });
          if (Number(capacity[0]?.total) >= 10000 || Number(capacity[0]?.company) >= 50) dingtalkDenied();
        }
        const fresh = await tx.query<QueryResultRow>({
          name: "dingtalk_visible_fresh_v1",
          text: `SELECT $1::timestamptz BETWEEN
        clock_timestamp()-interval '10 minutes' AND clock_timestamp()+interval '30 seconds'
          AND NOT EXISTS(SELECT 1 FROM data.app_dingtalk_company_fences
            WHERE app_identity=$2 AND company_digest=$3 AND changed_at>=$1::timestamptz) AS fresh`,
          values: [at, identity, company],
          maxRows: 1,
        });
        if (!fresh[0]?.fresh) dingtalkDenied();
        if (incoming < time || (incoming === time && (prior?.ambiguous || prior?.event_digest === digest)))
          return !prior?.ambiguous;
        const ambiguous = incoming === time,
          version = Number(prior?.version ?? 0) + 1;
        const row = {
          app_identity: identity,
          company_digest: company,
          app_id: visible.appId,
          version,
        };
        const encrypted = ambiguous
          ? {}
          : await encryptSecretValue(this.key, owner(row), "scope", version, JSON.stringify(visible));
        await tx.query({
          name: "dingtalk_visible_save_v1",
          text: `INSERT INTO data.app_dingtalk_company_visibility
        (app_identity,company_digest,app_id,version,event_time,event_digest,ambiguous,encrypted_value_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(app_identity,company_digest,app_id) DO UPDATE SET
          version=EXCLUDED.version,event_time=EXCLUDED.event_time,event_digest=EXCLUDED.event_digest,
          ambiguous=EXCLUDED.ambiguous,encrypted_value_json=EXCLUDED.encrypted_value_json`,
          values: [identity, company, visible.appId, version, at, digest, ambiguous, JSON.stringify(encrypted)],
          maxRows: 0,
        });
        return !ambiguous;
      },
    );
    // Ambiguity commits the erased snapshot before the caller receives rejection.
    if (!result) dingtalkDenied();
  }
}
