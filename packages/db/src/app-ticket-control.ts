import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { appRequestText as text } from "./app-request-text.js";
import { encryptSecretValue, decryptSecretValue } from "./secret-value-control.js";

const POLICIES = {
  feishu: { table: "app_feishu_tickets", lifetime: "2 hours", prefix: "feishu-app", ref: "app-ticket", bound: 4096 },
  dingtalk: { table: "app_dingtalk_suite_tickets", lifetime: null, prefix: "dingtalk-suite", ref: "suite-ticket", bound: 512 },
  wecom: { table: "app_wecom_suite_tickets", lifetime: "30 minutes", prefix: "wecom-suite", ref: "suite-ticket", bound: 512 },
} as const;
export function appTicketEventTime(value: string): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new AppControlError("invalid_app_request", 400, "Invalid application ticket time");
  }
  return new Date(value).toISOString();
}
type Request = { requestId: string; identity: string };
/** Fixed provider policies; this Hub-only authority never accepts a caller-selected table or expiry. */
export class PostgresAppTicketRepository {
  private readonly policy;
  constructor(private readonly database: AuthorityDatabase, private readonly material: string,
    private readonly provider: keyof typeof POLICIES) {
    this.policy = POLICIES[provider];
    if (!Object.hasOwn(POLICIES, provider) || !this.policy || database.cacheMode !== "disabled" || !material) throw new AppControlError(
      `${provider}_authority_unavailable`, 503, "Application ticket authority is not configured");
  }
  async accept(input: Request & { eventId: string; eventTime: string; ticket: string }): Promise<void> {
    const identity = text(input.identity, "appIdentity", 600), time = appTicketEventTime(input.eventTime);
    const eventId = text(input.eventId, "eventId", 128), ticket = text(input.ticket, "ticket", this.policy.bound);
    const outcome = await this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: `app.${this.provider}.ticket` }, async tx => {
      await tx.query({ name: `${this.provider}_app_ticket_lock_v1`, text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        values: [`${this.policy.prefix}:${identity}`], maxRows: 1 });
      const fresh = await tx.query<QueryResultRow>({ name: "app_ticket_fresh_v1", text: `SELECT 1
        WHERE $1::timestamptz>=clock_timestamp()-interval '10 minutes'
          AND $1::timestamptz<=clock_timestamp()+interval '30 seconds'`, values: [time], maxRows: 1 });
      if (!fresh.length) throw new AppControlError(`${this.provider}_event_expired`, 409, "Application ticket expired");
      const rows = await tx.query<QueryResultRow>({ name: `${this.provider}_ticket_read_locked_v2`, text: `SELECT version,event_time,event_id
        FROM data.${this.policy.table} WHERE app_identity=$1 FOR UPDATE`, values: [identity], maxRows: 1 });
      const previous = rows[0];
      if (previous && previous.event_id !== eventId && this.provider !== "feishu" &&
          Date.parse(time) === new Date(previous.event_time).getTime()) {
        // Provider timestamps have second precision. Conflicting tickets have no trustworthy ordering.
        await tx.query({ name: `${this.provider}_ticket_conflict_v1`, text: `UPDATE data.${this.policy.table}
          SET ambiguous=true,encrypted_value_json='{}'::jsonb,updated_at=clock_timestamp() WHERE app_identity=$1`,
        values: [identity], maxRows: 0 });
        return "ambiguous";
      }
      if (previous && (previous.event_id === eventId || Date.parse(time) <= new Date(previous.event_time).getTime())) return;
      const version = Number(previous?.version ?? 0) + 1;
      if (!Number.isSafeInteger(version)) throw new AppControlError(`${this.provider}_ticket_version_invalid`, 503, "Application ticket version is invalid");
      const envelope = await encryptSecretValue(this.material, `${this.policy.prefix}:${identity}`, this.policy.ref, version, ticket);
      await tx.query({ name: `${this.provider}_ticket_save_v2`, text: `INSERT INTO data.${this.policy.table}
        (app_identity,version,encrypted_value_json,event_id,event_time,updated_at) VALUES ($1,$2,$3::jsonb,$4,$5,clock_timestamp())
        ON CONFLICT (app_identity) DO UPDATE SET version=EXCLUDED.version,encrypted_value_json=EXCLUDED.encrypted_value_json,
          event_id=EXCLUDED.event_id,event_time=EXCLUDED.event_time,updated_at=EXCLUDED.updated_at${this.provider !== "feishu" ? ",ambiguous=false" : ""}`,
      values: [identity, version, JSON.stringify(envelope), eventId, time], maxRows: 0 });
    });
    if (outcome === "ambiguous") throw new AppControlError(`${this.provider}_ticket_ambiguous`, 409, "Waiting for a newer unambiguous application ticket");
  }
  async resolve(input: Request): Promise<string> {
    return (await this.snapshot(input)).value;
  }
  /** Version accompanies the same primary encrypted read; it is never inferred from a cached ticket. */
  async snapshot(input: Request): Promise<{ value: string; version: number }> {
    const identity = text(input.identity, "appIdentity", 600);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: `app.${this.provider}.ticket-resolve` }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: `${this.provider}_ticket_resolve_v2`, text: `SELECT encrypted_value_json,version
        FROM data.${this.policy.table} WHERE app_identity=$1 ${this.policy.lifetime ? `AND event_time>=clock_timestamp()-interval '${this.policy.lifetime}'` : ''}
          AND event_time<=clock_timestamp()+interval '30 seconds' ${this.provider !== "feishu" ? "AND NOT ambiguous" : ""} LIMIT 1`, values: [identity], maxRows: 1 });
      if (!rows[0]) throw new AppControlError(`${this.provider}_ticket_missing`, 503, "Waiting for the company application's ticket");
      return { value: await decryptSecretValue(this.material, { ...rows[0], owner_user_id: `${this.policy.prefix}:${identity}`, secret_ref: this.policy.ref,
        authority_version: rows[0].version }), version: Number(rows[0].version) };
    });
  }
}
