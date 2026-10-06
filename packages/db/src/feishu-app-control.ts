import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { appRequestText as text } from "./app-request-text.js";
import { PostgresAppTicketRepository, appTicketEventTime as at } from "./app-ticket-control.js";
import { feishuAppIdentity, type FeishuAppIdentity } from "./googlechat-room-control.js";

type Request = { requestId: string; app: FeishuAppIdentity };
type Event = Request & { eventId: string; eventTime: string };
function tenant(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) throw new AppControlError("invalid_app_request", 400, "Invalid Feishu tenant");
  return value;
}
async function fresh(tx: DatabaseTransaction, identity: string, eventTime: string) {
  await tx.query({ name: "feishu_app_lifecycle_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    values: [`feishu-app:${identity}`], maxRows: 1 });
  const rows = await tx.query<QueryResultRow>({ name: "feishu_app_event_fresh_v1", text: `SELECT 1
    WHERE $1::timestamptz>=clock_timestamp()-interval '10 minutes'
      AND $1::timestamptz<=clock_timestamp()+interval '30 seconds'`, values: [eventTime], maxRows: 1 });
  if (!rows.length) throw new AppControlError("feishu_event_expired", 409, "Feishu lifecycle event expired");
}

/** One primary app-policy authority; pushed app tickets remain encrypted and Hub-only. */
export class PostgresFeishuAppRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly material: string) {
    if (database.cacheMode !== "disabled" || !material) throw new AppControlError(
      "feishu_authority_unavailable", 503, "Feishu app authority is not configured");
  }
  async acceptTicket(input: Event & { ticket: string }): Promise<void> {
    await new PostgresAppTicketRepository(this.database, this.material, "feishu").accept({
      ...input, identity: feishuAppIdentity(input.app) });
  }
  async ticket(input: Request): Promise<string> {
    return new PostgresAppTicketRepository(this.database, this.material, "feishu").resolve({
      ...input, identity: feishuAppIdentity(input.app) });
  }
  async applyTenant(input: Event & { tenantKey: string; active: boolean }): Promise<void> {
    const identity = feishuAppIdentity(input.app), key = tenant(input.tenantKey), time = at(input.eventTime);
    const eventId = text(input.eventId, "eventId", 128);
    if (typeof input.active !== "boolean") throw new AppControlError("invalid_app_request", 400, "Invalid Feishu application status");
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.feishu.tenant-lifecycle" }, async tx => {
      await fresh(tx, identity, time);
      await tx.query({ name: "feishu_tenant_lifecycle_v1", text: `INSERT INTO data.app_feishu_tenant_lifecycle
        (app_identity,tenant_key,active,retired_at,event_id,event_time) VALUES ($1,$2,$3,CASE WHEN $3 THEN NULL ELSE $5::timestamptz END,$4,$5)
        ON CONFLICT (app_identity,tenant_key) DO UPDATE SET
          active=CASE WHEN EXCLUDED.event_time>data.app_feishu_tenant_lifecycle.event_time
            OR (EXCLUDED.event_time=data.app_feishu_tenant_lifecycle.event_time AND NOT EXCLUDED.active)
            THEN EXCLUDED.active ELSE data.app_feishu_tenant_lifecycle.active END,
          retired_at=CASE WHEN NOT EXCLUDED.active THEN GREATEST(data.app_feishu_tenant_lifecycle.retired_at,EXCLUDED.event_time)
            ELSE data.app_feishu_tenant_lifecycle.retired_at END,
          event_id=CASE WHEN EXCLUDED.event_time>=data.app_feishu_tenant_lifecycle.event_time THEN EXCLUDED.event_id
            ELSE data.app_feishu_tenant_lifecycle.event_id END,
          event_time=GREATEST(data.app_feishu_tenant_lifecycle.event_time,EXCLUDED.event_time)
        WHERE EXCLUDED.event_time>data.app_feishu_tenant_lifecycle.event_time
          OR (NOT EXCLUDED.active AND (data.app_feishu_tenant_lifecycle.retired_at IS NULL
            OR EXCLUDED.event_time>=data.app_feishu_tenant_lifecycle.retired_at))`,
      values: [identity, key, input.active, eventId, time], maxRows: 0 });
    });
  }
  async assertTenant(input: Request & { tenantKey: string }): Promise<void> {
    const identity = feishuAppIdentity(input.app), key = tenant(input.tenantKey);
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.feishu.tenant-current" }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "feishu_tenant_current_v1", text: `SELECT 1
        FROM data.app_feishu_tenant_lifecycle WHERE app_identity=$1 AND tenant_key=$2 AND active LIMIT 1`,
      values: [identity, key], maxRows: 1 });
      if (!rows.length) throw new AppControlError("feishu_tenant_inactive", 409, "Enable the xMatrix app in this Feishu tenant");
    });
  }
}
