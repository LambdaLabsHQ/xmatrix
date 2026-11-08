import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";

export interface AppleCommerceState { kind: "subscription" | "inAppPurchase"; id: string; state: string }
export interface AppleCommerceChange extends AppleCommerceState { previous: string; sequence: string }
export interface AppleCommerceJob {
  relationId: string; relationVersion: number; spaceId: string; channelId: string; connectionId: string;
  generation: string; credentialVersion: number; userId: string; sourceRef: string; leaseId: string;
  snapshot: AppleCommerceState[] | null; pending: AppleCommerceChange[]; sequence: string;
}
const JOIN = `FROM data.app_source_relations r JOIN data.app_connector_connections c
  ON c.connection_id=r.connection_id AND c.space_id=r.space_id
  JOIN data.app_connector_credentials k ON k.connection_id=c.connection_id AND k.space_id=c.space_id
  JOIN data.channels channel ON channel.channel_id=r.channel_id AND channel.space_id=r.space_id`;
const LIVE = `c.provider_id='appstoreconnect' AND c.status='configured' AND r.source_kind='repository'
  AND r.features_json ? 'commerce' AND lower(r.source_ref) ~ '^appstoreconnect:[a-z0-9][a-z0-9.-]{0,154}$'
  AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=r.space_id)
  AND ${channelCapabilityPredicate({ capability: "app_new_work", channelAlias: "channel", principalKindSql: "'user'", principalIdSql: "r.created_by" })}`;
const invalid = () => new AppControlError("invalid_commerce_snapshot", 502, "Invalid Apple commerce state snapshot");
function snapshot(value: AppleCommerceState[]): AppleCommerceState[] {
  if (!Array.isArray(value) || value.length > 500) throw invalid();
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || Object.keys(row).length !== 3 || !["subscription", "inAppPurchase"].includes(row.kind) ||
      !/^[A-Za-z0-9-]{1,100}$/u.test(row.id) ||
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(row.state) || seen.has(`${row.kind}:${row.id}`)) throw invalid();
    seen.add(`${row.kind}:${row.id}`);
  }
  return value.map(row => ({ kind: row.kind, id: row.id, state: row.state }));
}
function job(row: QueryResultRow): AppleCommerceJob {
  return { relationId: String(row.relation_id), relationVersion: Number(row.relation_version),
    spaceId: String(row.space_id), channelId: String(row.channel_id), connectionId: String(row.connection_id),
    generation: String(row.connection_generation), credentialVersion: Number(row.credential_version),
    userId: String(row.created_by), sourceRef: String(row.source_ref), leaseId: String(row.lease_id),
    snapshot: row.snapshot_json as AppleCommerceState[] | null, pending: row.pending_json as AppleCommerceChange[], sequence: String(row.sequence) };
}

/** Derived polling/outbox facts owned by the uncached primary App authority.
 * Current source relations, grants and credentials remain the authorization. */
export class PostgresAppleCommerceRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new AppControlError("cached_authority_forbidden", 500, "Commerce watches require uncached authority");
  }
  private transaction<T>(operation: string, work: (tx: DatabaseTransaction) => Promise<T>) {
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: `app.apple-commerce.${operation}` }, work);
  }
  async claim(): Promise<AppleCommerceJob[]> {
    return this.transaction("claim", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "apple_commerce_candidates_v1", text: `SELECT r.relation_id,r.version AS relation_version,
        r.space_id,r.channel_id,r.connection_id,r.created_by,lower(r.source_ref) AS source_ref,
        c.search_rank_sequence AS connection_generation,k.version AS credential_version
        ${JOIN} LEFT JOIN data.app_apple_commerce_watches w ON w.relation_id=r.relation_id
        WHERE ${LIVE} AND (w.lease_until IS NULL OR w.lease_until<=now()) AND
          (w.available_at IS NULL OR w.available_at<=now() OR w.relation_version<>r.version
           OR w.connection_generation<>c.search_rank_sequence OR w.credential_version<>k.version)
        ORDER BY COALESCE(w.available_at,'epoch'::timestamptz),r.relation_id LIMIT 8 FOR UPDATE OF r SKIP LOCKED`, values: [], maxRows: 8 });
      const jobs: AppleCommerceJob[] = [];
      for (const row of rows) {
        const lease = crypto.randomUUID();
        const fresh = await tx.query<QueryResultRow>({ name: "apple_commerce_lease_v1", text: `INSERT INTO data.app_apple_commerce_watches
          (relation_id,relation_version,connection_generation,credential_version,lease_id,lease_until)
          VALUES($1,$2,$3,$4,$5::uuid,now()+interval '3 minutes')
          ON CONFLICT(relation_id) DO UPDATE SET relation_version=EXCLUDED.relation_version,
            connection_generation=EXCLUDED.connection_generation,credential_version=EXCLUDED.credential_version,
            snapshot_json=CASE WHEN app_apple_commerce_watches.relation_version=EXCLUDED.relation_version
              AND app_apple_commerce_watches.connection_generation=EXCLUDED.connection_generation
              AND app_apple_commerce_watches.credential_version=EXCLUDED.credential_version THEN app_apple_commerce_watches.snapshot_json END,
            pending_json=CASE WHEN app_apple_commerce_watches.relation_version=EXCLUDED.relation_version
              AND app_apple_commerce_watches.connection_generation=EXCLUDED.connection_generation
              AND app_apple_commerce_watches.credential_version=EXCLUDED.credential_version THEN app_apple_commerce_watches.pending_json ELSE '[]'::jsonb END,
            lease_id=EXCLUDED.lease_id,lease_until=EXCLUDED.lease_until RETURNING snapshot_json,pending_json,sequence`,
          values: [row.relation_id, row.relation_version, row.connection_generation, row.credential_version, lease], maxRows: 1 });
        jobs.push(job({ ...row, ...fresh[0], lease_id: lease }));
      }
      return jobs;
    });
  }
  private async locked(tx: DatabaseTransaction, input: AppleCommerceJob) {
    const rows = await tx.query<QueryResultRow>({ name: "apple_commerce_current_v1", text: `SELECT w.snapshot_json,w.pending_json,w.sequence
      ${JOIN} JOIN data.app_apple_commerce_watches w ON w.relation_id=r.relation_id
      WHERE ${LIVE} AND w.relation_id=$1 AND w.lease_id=$2::uuid AND w.lease_until>now()
        AND r.version=$3 AND c.search_rank_sequence=$4 AND k.version=$5
        AND w.relation_version=r.version AND w.connection_generation=c.search_rank_sequence AND w.credential_version=k.version
      FOR UPDATE OF w`, values: [input.relationId,input.leaseId,input.relationVersion,input.generation,input.credentialVersion], maxRows: 1 });
    return rows[0];
  }
  async current(input: AppleCommerceJob) { return this.transaction("current", async tx => Boolean(await this.locked(tx, input))); }
  async stage(input: AppleCommerceJob, states: AppleCommerceState[]): Promise<AppleCommerceChange[]> {
    const next = snapshot(states);
    return this.transaction("stage", async tx => {
      const row = await this.locked(tx,input);
      if (!row) throw new AppControlError("commerce_grant_changed",409,"Commerce notification access changed");
      const pending = row.pending_json as AppleCommerceChange[];
      if (pending.length) return pending;
      const prior = row.snapshot_json as AppleCommerceState[] | null;
      const before = new Map(prior?.map(state => [`${state.kind}:${state.id}`,state]) ?? []);
      let sequence = BigInt(String(row.sequence));
      const changes: AppleCommerceChange[] = [];
      for (const state of next) {
        const old = before.get(`${state.kind}:${state.id}`);
        if (old && old.state !== state.state) changes.push({ ...state, previous: old.state, sequence: String(++sequence) });
      }
      await tx.query({ name: "apple_commerce_stage_v1", text: `UPDATE data.app_apple_commerce_watches
        SET snapshot_json=$3::jsonb,pending_json=$4::jsonb,sequence=$5 WHERE relation_id=$1 AND lease_id=$2::uuid`,
        values: [input.relationId,input.leaseId,JSON.stringify(next),JSON.stringify(changes),String(sequence)], maxRows: 0 });
      return changes;
    });
  }
  async delivered(input: AppleCommerceJob, sequence: string) {
    return this.transaction("delivered",async tx => {
      if (!await this.locked(tx,input)) return;
      await tx.query({ name: "apple_commerce_delivered_v1", text: `UPDATE data.app_apple_commerce_watches
        SET pending_json=COALESCE((SELECT jsonb_agg(event) FROM jsonb_array_elements(pending_json) event
          WHERE event->>'sequence'<>$3),'[]'::jsonb) WHERE relation_id=$1 AND lease_id=$2::uuid`,
        values: [input.relationId,input.leaseId,sequence], maxRows: 0 });
    });
  }
  async finish(input: AppleCommerceJob, retry: boolean) {
    return this.transaction("finish",async tx => {
      await tx.query({ name: "apple_commerce_finish_v1", text: `UPDATE data.app_apple_commerce_watches SET lease_id=NULL,lease_until=NULL,
        available_at=now()+CASE WHEN $3 THEN interval '1 minute' ELSE interval '5 minutes' END
        WHERE relation_id=$1 AND lease_id=$2::uuid`, values: [input.relationId,input.leaseId,retry], maxRows: 0 });
    });
  }
}
