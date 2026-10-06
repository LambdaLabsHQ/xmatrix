import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { AppControlError, appRequestFields } from "./app-control.js";
import { lockSentryInstallation, sentryInstallationKey } from "./sentry-installation-lifecycle.js";

/** Narrow provider references only; no title, URL, actor, exception, request or token. */
export interface SentryEventIdentity {
  kind: "issue" | "event_alert" | "metric_alert";
  action: string;
  objectId: string;
  projectId?: string;
  projectSlug?: string;
  organizationId?: string;
  organizationSlug?: string;
  projects?: string[];
}
export interface SentryEventKey { appClientId: string; appUuid: string; installationId: string; deliveryDigest: string }
export interface SentryEventJob extends SentryEventKey {
  connectionId: string; spaceId: string; grantGeneration: string; leaseId: string;
  identity: SentryEventIdentity;
}
const NUMERIC = /^[1-9][0-9]{0,31}$/u;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const ISSUE_ACTIONS = ["created", "resolved", "unresolved", "assigned", "ignored", "archived"];
const invalid = () => new AppControlError("invalid_app_request", 400, "Invalid Sentry event identity");

export function validateSentryEventIdentity(value: SentryEventIdentity): SentryEventIdentity {
  const fields = value.kind === "issue" ? ["kind", "action", "objectId", "projectId", "projectSlug"] :
    value.kind === "event_alert" ? ["kind", "action", "objectId", "projectId", "projectSlug", "organizationSlug"] :
      value.kind === "metric_alert" ? ["kind", "action", "objectId", "organizationId", "projects"] : [];
  if (!fields.length || typeof value.objectId !== "string" ||
      [value.projectId, value.projectSlug, value.organizationId, value.organizationSlug].some(item => item !== undefined && typeof item !== "string") ||
      Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) ||
      (value.kind === "issue" ? !ISSUE_ACTIONS.includes(value.action) || !NUMERIC.test(value.objectId) :
        value.kind === "event_alert" ? value.action !== "triggered" || !/^[a-f0-9]{32}$/u.test(value.objectId) :
          !["triggered", "resolved"].includes(value.action) || !NUMERIC.test(value.objectId)) ||
      (value.kind !== "metric_alert" && (!NUMERIC.test(value.projectId ?? "") || !SLUG.test(value.projectSlug ?? ""))) ||
      (value.kind === "event_alert" && !SLUG.test(value.organizationSlug ?? "")) ||
      (value.kind === "metric_alert" && (!NUMERIC.test(value.organizationId ?? "") || !Array.isArray(value.projects) ||
        value.projects.length < 1 || value.projects.length > 10 || value.projects.some(item => typeof item !== "string" || !SLUG.test(item)) ||
        new Set(value.projects).size !== value.projects.length))) throw invalid();
  return { ...value, ...(value.projects ? { projects: [...value.projects].sort() } : {}) };
}
function key(input: SentryEventKey): [string, string, string, string] {
  const installation = { appClientId: input.appClientId, installationId: input.installationId, eventScopeId: input.appUuid };
  if (!/^[a-f0-9]{64}$/u.test(input.deliveryDigest)) throw invalid();
  return [...sentryInstallationKey(installation), input.deliveryDigest];
}
function request(input: { requestId: string }) { return appRequestFields.text(input.requestId, "requestId", 200); }
const ACTIVE_BINDING = `FROM data.app_connector_oauth_installations i
  JOIN data.app_connector_connections c ON c.connection_id=i.connection_id AND c.space_id=i.space_id
    AND c.provider_id='sentry' AND c.status='configured'
  JOIN data.app_connector_credentials k ON k.connection_id=i.connection_id AND k.space_id=i.space_id AND k.version=i.credential_version
  WHERE i.provider_id='sentry' AND i.app_client_id=$1 AND i.event_scope_id=$2 AND i.installation_id=$3
    AND i.grant_generation IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=i.space_id)`;

/** Primary App authority's receipt and retry facts. Private provider bodies never enter this store. */
export class PostgresSentryEventRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new AppControlError("cached_authority_forbidden", 500,
      "Sentry event authority requires uncached PostgreSQL");
  }

  async accept(input: SentryEventKey & { requestId: string; identity: SentryEventIdentity }) {
    const values = key(input);
    const identity = validateSentryEventIdentity(input.identity);
    return this.database.transaction({ requestId: request(input), operation: "app.sentry-event.accept" }, async tx => {
      // App-scoped serialization makes the 1,000 outstanding job bound safe under parallel receipts.
      await this.lockApp(tx, values);
      const { retired } = await lockSentryInstallation(tx, { appClientId: input.appClientId,
        installationId: input.installationId, eventScopeId: input.appUuid });
      if (retired) return { accepted: true, retired: true, reused: false, jobs: 0 };
      const previous = await tx.query({ name: "sentry_event_replay_v1", text: `SELECT delivery_digest
        FROM data.app_sentry_event_receipts WHERE app_client_id=$1 AND app_uuid=$2::uuid
          AND installation_uuid=$3::uuid AND delivery_digest=$4 AND expires_at>statement_timestamp() LIMIT 1`, values, maxRows: 1 });
      if (previous.length) return { accepted: true, retired: false, reused: true, jobs: 0 };
      await this.cleanup(tx, values);
      await tx.query({ name: "sentry_event_expired_replay_v1", text: `DELETE FROM data.app_sentry_event_receipts
        WHERE app_client_id=$1 AND app_uuid=$2::uuid AND installation_uuid=$3::uuid AND delivery_digest=$4
          AND expires_at<=statement_timestamp()`, values, maxRows: 0 });
      const receipts = await tx.query({ name: "sentry_event_receipt_capacity_v1", text: `SELECT count(*) AS count FROM (SELECT 1
        FROM data.app_sentry_event_receipts WHERE app_client_id=$1 AND app_uuid=$2::uuid LIMIT 10000) bounded`,
      values: values.slice(0, 2), maxRows: 1 });
      if (Number((receipts[0] as QueryResultRow).count) >= 10000) throw new AppControlError("sentry_event_backlog_full", 503,
        "Sentry receipt retention capacity reached", true);
      const targets = await tx.query<QueryResultRow>({ name: "sentry_event_targets_v1",
        text: `SELECT i.connection_id,i.space_id,i.grant_generation ${ACTIVE_BINDING}
          ORDER BY i.connection_id LIMIT 51`, values: values.slice(0, 3), maxRows: 51 });
      if (!targets.length || targets.length > 50) throw new AppControlError("sentry_event_unavailable", 503,
        "Sentry event bindings are unavailable", true);
      const backlog = await tx.query({ name: "sentry_event_backlog_v1", text: `SELECT count(*) AS count FROM (SELECT 1
        FROM data.app_sentry_event_jobs WHERE app_client_id=$1 AND app_uuid=$2::uuid AND state IN ('pending','leased')
        LIMIT 1001) bounded`, values: values.slice(0, 2), maxRows: 1 });
      if (Number((backlog[0] as QueryResultRow).count) + targets.length > 1000) throw new AppControlError("sentry_event_backlog_full", 503,
        "Sentry event backlog is full", true);
      await tx.query({ name: "sentry_event_receipt_write_v1", text: `INSERT INTO data.app_sentry_event_receipts
        (app_client_id,app_uuid,installation_uuid,delivery_digest,identity_json) VALUES ($1,$2::uuid,$3::uuid,$4,$5::jsonb)`,
      values: [...values, JSON.stringify(identity)], maxRows: 0 });
      await tx.query({ name: "sentry_event_jobs_write_v1", text: `INSERT INTO data.app_sentry_event_jobs
        (app_client_id,app_uuid,installation_uuid,delivery_digest,connection_id,space_id,grant_generation)
        SELECT $1,$2::uuid,$3::uuid,$4,t.connection_id,t.space_id,t.grant_generation::uuid FROM
          jsonb_to_recordset($5::jsonb) AS t(connection_id text,space_id text,grant_generation text)`,
      values: [...values, JSON.stringify(targets)], maxRows: 0 });
      return { accepted: true, retired: false, reused: false, jobs: targets.length };
    });
  }

  private async lockApp(tx: DatabaseTransaction, values: readonly string[]) {
    await tx.query({ name: "sentry_event_capacity_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      values: [JSON.stringify(["sentry-events", ...values.slice(0, 2)])], maxRows: 1 });
  }

  private async cleanup(tx: DatabaseTransaction, values: readonly string[]) {
    await tx.query({ name: "sentry_event_exhausted_v1", text: `UPDATE data.app_sentry_event_jobs
      SET state='failed',lease_id=NULL,lease_until=NULL,updated_at=statement_timestamp()
      WHERE (app_client_id,app_uuid,installation_uuid,delivery_digest,connection_id) IN
        (SELECT app_client_id,app_uuid,installation_uuid,delivery_digest,connection_id FROM data.app_sentry_event_jobs
          WHERE app_client_id=$1 AND app_uuid=$2::uuid AND state='leased' AND attempts>=8
            AND lease_until<=statement_timestamp() ORDER BY lease_until LIMIT 4 FOR UPDATE SKIP LOCKED)`,
    values: values.slice(0, 2), maxRows: 0 });
    // Each receipt has at most 50 children. Two receipts => at most 100 job deletions.
    await tx.query({ name: "sentry_event_cleanup_v1", text: `DELETE FROM data.app_sentry_event_receipts
      WHERE (app_client_id,app_uuid,installation_uuid,delivery_digest) IN
        (SELECT app_client_id,app_uuid,installation_uuid,delivery_digest FROM data.app_sentry_event_receipts
          WHERE app_client_id=$1 AND app_uuid=$2::uuid AND expires_at<=statement_timestamp()
          ORDER BY expires_at,installation_uuid,delivery_digest LIMIT 2 FOR UPDATE SKIP LOCKED)`,
    values: values.slice(0, 2), maxRows: 0 });
  }

  async claim(input: { requestId: string; appClientId: string; appUuid: string }): Promise<SentryEventJob[]> {
    const values = sentryInstallationKey({ appClientId: input.appClientId, eventScopeId: input.appUuid,
      installationId: "00000000-0000-0000-0000-000000000000" }).slice(0, 2);
    return this.database.transaction({ requestId: request(input), operation: "app.sentry-event.claim" }, async tx => {
      await this.lockApp(tx, values);
      await this.cleanup(tx, values);
      const active = await tx.query<QueryResultRow>({ name: "sentry_event_active_leases_v1", text: `SELECT count(*) AS count
        FROM (SELECT 1 FROM data.app_sentry_event_jobs WHERE app_client_id=$1 AND app_uuid=$2::uuid
          AND state='leased' AND lease_until>statement_timestamp() LIMIT 9) bounded`, values, maxRows: 1 });
      const slots = Math.max(0, Math.min(4, 8-Number(active[0]!.count)));
      if (!slots) return [];
      // Expired leases are reclaimable after a crash; every claim gets a new fenced nonce.
      const rows = await tx.query<QueryResultRow>({ name: "sentry_event_claim_v1", text: `WITH due AS
        (SELECT j.app_client_id,j.app_uuid,j.installation_uuid,j.delivery_digest,j.connection_id
         FROM data.app_sentry_event_jobs j WHERE j.app_client_id=$1 AND j.app_uuid=$2::uuid AND j.attempts<8
          AND EXISTS (SELECT 1 FROM data.app_sentry_event_receipts r WHERE r.app_client_id=j.app_client_id
            AND r.app_uuid=j.app_uuid AND r.installation_uuid=j.installation_uuid AND r.delivery_digest=j.delivery_digest
            AND r.expires_at>statement_timestamp())
          AND ((j.state='pending' AND j.available_at<=statement_timestamp()) OR
            (j.state='leased' AND j.lease_until<=statement_timestamp()))
         ORDER BY j.available_at,j.delivery_digest,j.connection_id LIMIT $3 FOR UPDATE SKIP LOCKED), claimed AS
        (UPDATE data.app_sentry_event_jobs j SET state='leased',attempts=attempts+1,lease_id=gen_random_uuid(),
          lease_until=statement_timestamp()+interval '5 minutes',updated_at=statement_timestamp()
         FROM due d WHERE j.app_client_id=d.app_client_id AND j.app_uuid=d.app_uuid
          AND j.installation_uuid=d.installation_uuid AND j.delivery_digest=d.delivery_digest AND j.connection_id=d.connection_id
         RETURNING j.*)
        SELECT j.*,r.identity_json FROM claimed j JOIN data.app_sentry_event_receipts r
          USING (app_client_id,app_uuid,installation_uuid,delivery_digest)`, values: [...values, slots], maxRows: 4 });
      return rows.map(row => ({ appClientId: String(row.app_client_id), appUuid: String(row.app_uuid),
        installationId: String(row.installation_uuid), deliveryDigest: String(row.delivery_digest),
        connectionId: String(row.connection_id), spaceId: String(row.space_id), grantGeneration: String(row.grant_generation),
        leaseId: String(row.lease_id), identity: validateSentryEventIdentity(row.identity_json as SentryEventIdentity) }));
    });
  }

  /** A refresh retains grant_generation; a Human replacement or uninstall cannot revive accepted work. */
  async current(input: SentryEventJob & { requestId: string }): Promise<{ credentialVersion: number } | null> {
    return this.database.transaction({ requestId: request(input), operation: "app.sentry-event.current" }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "sentry_event_current_v1", text: `SELECT i.credential_version
        ${ACTIVE_BINDING} AND i.connection_id=$4 AND i.space_id=$5 AND i.grant_generation=$6::uuid
        AND EXISTS (SELECT 1 FROM data.app_sentry_event_jobs j WHERE j.app_client_id=$1 AND j.app_uuid=$2::uuid
          AND j.installation_uuid=$3::uuid AND j.delivery_digest=$7 AND j.connection_id=$4 AND j.space_id=$5
          AND j.state='leased' AND j.lease_id=$8::uuid AND j.lease_until>statement_timestamp())
        AND NOT EXISTS (SELECT 1 FROM data.app_sentry_installation_lifecycle l WHERE l.app_client_id=$1
          AND l.app_uuid=$2::uuid AND l.installation_uuid=$3::uuid AND l.retired_at IS NOT NULL) LIMIT 1`,
      values: [...key(input).slice(0, 3), input.connectionId, input.spaceId, input.grantGeneration,
        input.deliveryDigest, input.leaseId], maxRows: 1 });
      return rows[0] ? { credentialVersion: Number(rows[0].credential_version) } : null;
    });
  }

  async finish(input: SentryEventJob & { requestId: string; outcome: "done" | "obsolete" | "retry" }) {
    if (!UUID.test(input.leaseId) || !["done", "obsolete", "retry"].includes(input.outcome)) throw invalid();
    return this.database.transaction({ requestId: request(input), operation: "app.sentry-event.finish" }, async tx => {
      await tx.query({ name: "sentry_event_finish_v1", text: `UPDATE data.app_sentry_event_jobs SET
        state=CASE WHEN $7<>'retry' THEN $7 WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,
        available_at=statement_timestamp()+make_interval(secs=>least(3600,15*power(2,attempts))::int),
        lease_id=NULL,lease_until=NULL,updated_at=statement_timestamp()
        WHERE app_client_id=$1 AND app_uuid=$2::uuid AND installation_uuid=$3::uuid AND delivery_digest=$4
          AND connection_id=$5 AND state='leased' AND lease_id=$6::uuid AND lease_until>statement_timestamp()`,
      values: [...key(input), input.connectionId, input.leaseId, input.outcome], maxRows: 0 });
    });
  }
}
