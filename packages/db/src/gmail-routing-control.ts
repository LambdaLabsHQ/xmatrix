import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { decryptSecretValue, encryptSecretValue } from "./secret-value-control.js";

export interface GmailRoutingSelection {
  address: string; account: string; owner: string;
  oauthVerifier: string; refreshToken?: string; appIdentity: string;
  pollToken?: { accessToken: string; expiresAt: number };
}
export interface GmailRoutingJob {
  id: string; spaceId: string; connectionId: string; credentialVersion: number; generation: string;
  userId: string; selection: GmailRoutingSelection; historyId: string;
  pageToken?: string; leaseId?: string; wakeVersion: number; pendingWake: boolean; lastSignalAt?: string;
  lastVerifiedAt?: string; error?: string; enabled: boolean; expiresAt?: string; renewAt?: string;
  mode: "native" | "poll"; nextSearchAt?: string;
}
const fail = () => new AppControlError("gmail_routing_unavailable", 409, "Mailbox notification access changed; reconnect notifications");

/** Primary, uncached notification authority; native refresh grants are encrypted at this boundary. */
export class PostgresGmailRoutingRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly material: string) {
    if (database.cacheMode !== "disabled" || !material) throw fail();
  }
  private transaction<T>(operation: string, run: (tx: DatabaseTransaction) => Promise<T>) {
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: `app.gmail-routing.${operation}` }, run);
  }
  private async row(row: QueryResultRow): Promise<GmailRoutingJob> {
    const selection = JSON.parse(await decryptSecretValue(this.material, { encrypted_value_json: row.encrypted_value_json,
      owner_user_id: `gmail-route:${row.route_id}`, secret_ref: "selection", authority_version: 1 })) as GmailRoutingSelection;
    const date = (value: unknown) => value ? new Date(value as string).toISOString() : undefined;
    return { id: String(row.route_id), spaceId: String(row.space_id), connectionId: String(row.connection_id),
      credentialVersion: Number(row.credential_version), generation: String(row.connection_generation),
      userId: String(row.created_by), selection,
      historyId: String(row.history_id), pageToken: row.page_token ? String(row.page_token) : undefined,
      leaseId: row.lease_id ? String(row.lease_id) : undefined, wakeVersion: Number(row.wake_version), pendingWake:Number(row.wake_version)>Number(row.processed_version),
      lastSignalAt: date(row.last_signal_at), lastVerifiedAt: date(row.last_verified_at),
      expiresAt: date(row.expires_at), renewAt: date(row.renew_at),
      error: row.error_code ? String(row.error_code) : undefined, enabled: row.enabled === true,
      mode: row.notification_mode === "poll" ? "poll" : "native", nextSearchAt: date(row.next_search_at) };
  }
  private async authorize(tx: DatabaseTransaction, spaceId: string, userId: string) {
    const roles = await tx.query<QueryResultRow>({ name: "gmail_route_admin_v1", text: `SELECT role FROM data.space_members
      WHERE space_id=$1 AND user_id=$2 AND NOT EXISTS (SELECT 1 FROM data.space_deletions WHERE space_id=$1)
      AND NOT EXISTS (SELECT 1 FROM data.account_deletion_fences WHERE user_id=$2 AND (committed OR expires_at>clock_timestamp()))
      LIMIT 1 FOR SHARE`, values: [spaceId, userId], maxRows: 1 });
    if (!["owner", "admin"].includes(String(roles[0]?.role))) throw fail();
  }
  async list(spaceId: string, userId: string) {
    return this.transaction("list", async tx => {
      await this.authorize(tx, spaceId, userId);
      const rows = await tx.query<QueryResultRow>({ name: "gmail_route_list_v1", text: `SELECT * FROM data.app_gmail_routes
        WHERE space_id=$1 AND created_by=$2 AND encrypted_value_json<>'{}'::jsonb ORDER BY created_at DESC LIMIT 20`, values: [spaceId, userId], maxRows: 20 });
      return Promise.all(rows.map(row => this.row(row)));
    });
  }
  async consumeOAuth(id: string, userId: string, nonceDigest: string) {
    return this.transaction("consume-oauth", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "gmail_route_oauth_consume_v1", text: `UPDATE data.app_gmail_routes
        SET oauth_consumed=true WHERE route_id=$1 AND created_by=$2 AND oauth_nonce_digest=$3
          AND NOT oauth_consumed AND NOT enabled AND created_at>now()-interval '10 minutes' RETURNING *`,
      values: [id,userId,nonceDigest], maxRows: 1 });
      if (!rows[0]) throw fail();
      const job = await this.row(rows[0]);
      await this.authorize(tx,job.spaceId,userId);
      return job;
    });
  }
  async activate(job: GmailRoutingJob, refreshToken: string, historyId: string, expiresAt?: string,
    poll?: { token: NonNullable<GmailRoutingSelection["pollToken"]>; fingerprint: string }) {
    if((job.mode==="poll")!==!!poll || (job.mode==="native" && !expiresAt))throw fail();
    return this.transaction("activate", async tx => {
      await this.authorize(tx,job.spaceId,job.userId);
      const current = await tx.query<QueryResultRow>({ name: "gmail_route_activation_grant_v1", text: `SELECT c.connection_id
        FROM data.app_connector_connections c JOIN data.app_connector_credentials k USING(connection_id,space_id)
        WHERE c.connection_id=$1 AND c.status='configured' AND c.search_rank_sequence=$2 AND k.version=$3
        FOR SHARE OF c,k`, values: [job.connectionId,job.generation,job.credentialVersion], maxRows: 1 });
      if (!current.length) throw fail();
      const envelope = await encryptSecretValue(this.material,`gmail-route:${job.id}`,"selection",1,
        JSON.stringify({...job.selection,oauthVerifier:"",refreshToken,...(poll ? {pollToken:poll.token} : {})}));
      await tx.query({ name: "gmail_route_activate_lock_v1",text:"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        values:[job.connectionId],maxRows:1 });
      await tx.query({name:"gmail_route_retire_previous_v1",text:`DELETE FROM data.app_gmail_routes old USING data.app_gmail_routes next
        WHERE next.route_id=$1 AND old.connection_id=next.connection_id AND old.mailbox_digest=next.mailbox_digest
          AND old.route_id<>next.route_id`,values:[job.id],maxRows:0});
      const rows=await tx.query({name:"gmail_route_activate_v1",text:`UPDATE data.app_gmail_routes SET enabled=true,
        encrypted_value_json=$2::jsonb,history_id=$3,expires_at=$4,
        renew_at=CASE WHEN notification_mode='native' THEN now()+interval '1 day' END,
        next_poll_at=CASE WHEN notification_mode='poll' THEN now() END,
        next_search_at=CASE WHEN notification_mode='poll' THEN now()+interval '15 minutes' END,inbox_fingerprint=$5
        WHERE route_id=$1 AND oauth_consumed AND created_at>now()-interval '10 minutes' RETURNING route_id`,
      values:[job.id,JSON.stringify(envelope),historyId,expiresAt ?? null,poll?.fingerprint ?? null],maxRows:1});
      if(!rows.length)throw fail();
    });
  }
  async renewed(job: GmailRoutingJob, expiresAt: string) {
    return this.transaction("renewed",tx=>tx.query({name:"gmail_route_renewed_v1",text:`UPDATE data.app_gmail_routes
      SET expires_at=$3,renew_at=now()+interval '1 day' WHERE route_id=$1 AND enabled AND lease_id=$2::uuid`,
    values:[job.id,job.leaseId,expiresAt],maxRows:0}));
  }
  async create(input: { spaceId: string; userId: string; credentialVersion: number;
    generation: string; mailboxDigest: string; tokenDigest: string; nonceDigest: string; selection: GmailRoutingSelection; historyId: string;
    mode?: "native" | "poll" }) {
    const id = crypto.randomUUID();
    const envelope = await encryptSecretValue(this.material, `gmail-route:${id}`, "selection", 1, JSON.stringify(input.selection));
    return this.transaction("create", async tx => {
      await this.authorize(tx, input.spaceId, input.userId);
      const connectionId = `${input.spaceId}:gmail`;
      const rows = await tx.query<QueryResultRow>({ name: "gmail_route_grant_v1", text: `SELECT c.connection_id
        FROM data.app_connector_connections c JOIN data.app_connector_credentials k USING(connection_id,space_id)
        WHERE c.connection_id=$1 AND c.status='configured' AND c.search_rank_sequence=$2 AND k.version=$3
        LIMIT 1 FOR SHARE OF c,k`, values: [connectionId, input.generation, input.credentialVersion], maxRows: 1 });
      if (!rows.length || input.selection.owner !== `user:${input.userId}`) throw fail();
      // Serialize mailbox configuration and bound active plus pending authorizations.
      await tx.query({ name: "gmail_route_configuration_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        values: [connectionId], maxRows: 1 });
      await tx.query({ name: "gmail_route_pending_cleanup_v1", text: `DELETE FROM data.app_gmail_routes
        WHERE connection_id=$1 AND NOT enabled AND (encrypted_value_json='{}'::jsonb OR (expires_at IS NULL AND error_code IS NULL AND created_at<now()-interval '10 minutes'))`,
        values: [connectionId], maxRows: 0 });
      const count = await tx.query<QueryResultRow>({ name: "gmail_route_count_v1", text: `SELECT count(*) AS count FROM
        (SELECT 1 FROM data.app_gmail_routes WHERE connection_id=$1 LIMIT 20) r`, values: [connectionId], maxRows: 1 });
      if (Number(count[0]?.count) >= 20) throw fail();
      await tx.query({ name: "gmail_route_create_v2", text: `INSERT INTO data.app_gmail_routes
        (route_id,space_id,connection_id,credential_version,connection_generation,created_by,
         mailbox_digest,token_digest,encrypted_value_json,history_id,oauth_nonce_digest,notification_mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`, values: [id, input.spaceId, connectionId,
      input.credentialVersion, input.generation, input.userId, input.mailboxDigest, input.tokenDigest,
      JSON.stringify(envelope), input.historyId,input.nonceDigest,input.mode ?? "native"], maxRows: 0 });
      return id;
    });
  }
  async stop(spaceId: string, userId: string, id: string) {
    return this.transaction("stop", async tx => {
      await this.authorize(tx, spaceId, userId);
      await tx.query({ name: "gmail_route_stop_v1", text: `UPDATE data.app_gmail_routes SET enabled=false,oauth_consumed=false,
        lease_id=NULL,lease_until=NULL,encrypted_value_json='{}'::jsonb,updated_at=now() WHERE route_id=$1 AND space_id=$2 AND created_by=$3`,
      values: [id, spaceId, userId], maxRows: 0 });
    });
  }
  /** Authenticated Pub/Sub is only an opaque wake. No provider content becomes work. */
  async signal(tokenDigest: string) {
    return this.transaction("signal", async tx => {
      await tx.query({ name: "gmail_route_signal_v1", text: `UPDATE data.app_gmail_routes
        SET wake_version=wake_version+1,last_signal_at=now(),attempts=0,error_code=NULL,updated_at=now()
        WHERE token_digest=$1 AND notification_mode='native' AND (enabled OR (oauth_consumed AND expires_at IS NULL AND created_at>now()-interval '10 minutes'))
        `, values: [tokenDigest], maxRows: 0 });
    });
  }
  async cleanup() {
    return this.transaction("cleanup", tx => tx.query({ name: "gmail_route_cleanup_v1", text: `DELETE FROM data.app_gmail_routes
      WHERE route_id IN (SELECT route_id FROM data.app_gmail_routes WHERE NOT enabled
        AND (encrypted_value_json='{}'::jsonb OR (expires_at IS NULL AND error_code IS NULL AND created_at<now()-interval '10 minutes'))
        ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, values: [], maxRows: 0 }));
  }
  async claim() {
    return this.transaction("claim", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "gmail_route_claim_v1", text: `WITH due AS
        (SELECT route_id FROM data.app_gmail_routes WHERE enabled AND (wake_version>processed_version OR renew_at<=now() OR next_poll_at<=now())
          AND (attempts<8 OR renew_at<=now() OR notification_mode='poll')
          AND available_at<=now() AND (lease_until IS NULL OR lease_until<=now())
          ORDER BY available_at,route_id LIMIT 20 FOR UPDATE SKIP LOCKED)
        UPDATE data.app_gmail_routes r SET lease_id=gen_random_uuid(),lease_until=now()+interval '2 minutes',
          attempts=least(attempts+1,8) FROM due WHERE r.route_id=due.route_id RETURNING r.*`, values: [], maxRows: 20 });
      return Promise.all(rows.map(row => this.row(row)));
    });
  }
  async current(job: GmailRoutingJob) {
    return this.transaction("current", async tx => {
      try { await this.authorize(tx, job.spaceId, job.userId); } catch (error) {
        if (error instanceof AppControlError && [403,404,409].includes(error.status)) return false;
        throw error;
      }
      const rows = await tx.query({ name: "gmail_route_current_v1", text: `SELECT r.route_id FROM data.app_gmail_routes r
        JOIN data.app_connector_connections c USING(connection_id,space_id)
        JOIN data.app_connector_credentials k USING(connection_id,space_id)
        WHERE r.route_id=$1 AND r.enabled AND r.lease_id=$2::uuid AND r.lease_until>now()
          AND c.status='configured' AND c.search_rank_sequence=r.connection_generation AND k.version=r.credential_version`,
      values: [job.id, job.leaseId], maxRows: 1 });
      return rows.length > 0;
    });
  }
  async pending(job: GmailRoutingJob): Promise<string[]> {
    return this.transaction("pending", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "gmail_route_pending_v1", text: `SELECT message_id
        FROM data.app_gmail_notifications WHERE route_id=$1 AND delivered_at IS NULL ORDER BY message_id LIMIT 50`,
      values: [job.id], maxRows: 50 });
      return rows.map(row => String(row.message_id));
    });
  }
  async cachePollToken(job: GmailRoutingJob, token: NonNullable<GmailRoutingSelection["pollToken"]>, refreshToken?: string) {
    const selection={...job.selection,pollToken:token,...(refreshToken ? {refreshToken} : {})};
    const envelope=await encryptSecretValue(this.material,`gmail-route:${job.id}`,"selection",1,JSON.stringify(selection));
    await this.transaction("poll-token",tx=>tx.query({name:"gmail_route_poll_token_v1",text:`UPDATE data.app_gmail_routes
      SET encrypted_value_json=$3::jsonb WHERE route_id=$1 AND enabled AND notification_mode='poll'
      AND lease_id=$2::uuid AND lease_until>now()`,values:[job.id,job.leaseId,JSON.stringify(envelope)],maxRows:0}));
    job.selection=selection;
  }
  /** Record a wake before querying upstream. A failed search must survive unchanged counters. */
  async polled(job: GmailRoutingJob, fingerprint: string) {
    if(!/^\d+(?:,\d+){3}$/u.test(fingerprint) || fingerprint.length>128)throw fail();
    return this.transaction("polled",async tx=>{
      const rows=await tx.query<QueryResultRow>({name:"gmail_route_polled_v1",text:`UPDATE data.app_gmail_routes
        SET wake_version=wake_version+CASE WHEN inbox_fingerprint IS DISTINCT FROM $3 THEN 1 ELSE 0 END,
          last_signal_at=CASE WHEN inbox_fingerprint IS DISTINCT FROM $3 THEN now() ELSE last_signal_at END,
          inbox_fingerprint=$3 WHERE route_id=$1 AND enabled AND notification_mode='poll'
          AND lease_id=$2::uuid AND lease_until>now() RETURNING wake_version,processed_version`,
      values:[job.id,job.leaseId,fingerprint],maxRows:1});
      if(!rows[0])throw fail();
      job.wakeVersion=Number(rows[0].wake_version);
      job.pendingWake=job.wakeVersion>Number(rows[0].processed_version);
    });
  }
  async searched(job: GmailRoutingJob) {
    return this.transaction("searched",tx=>tx.query({name:"gmail_route_searched_v1",text:`UPDATE data.app_gmail_routes
      SET next_search_at=now()+interval '15 minutes' WHERE route_id=$1 AND enabled AND notification_mode='poll'
        AND lease_id=$2::uuid AND lease_until>now()`,values:[job.id,job.leaseId],maxRows:0}));
  }
  async stage(job: GmailRoutingJob, messages: string[], historyId: string, pageToken?: string) {
    if (messages.length > 100 || messages.some(id => !/^[a-f0-9]{8,32}$/u.test(id))) throw fail();
    return this.transaction("stage", async tx => {
      const rows = await tx.query({ name: "gmail_route_stage_cursor_v1", text: `UPDATE data.app_gmail_routes
        SET history_id=$3,page_token=$4 WHERE route_id=$1 AND enabled AND lease_id=$2::uuid AND lease_until>now()
        RETURNING route_id`, values: [job.id, job.leaseId, historyId, pageToken ?? null], maxRows: 1 });
      if (!rows.length) throw fail();
      const pending = await tx.query<QueryResultRow>({ name: "gmail_route_outbox_capacity_v1", text: `SELECT count(*) AS count
        FROM (SELECT 1 FROM data.app_gmail_notifications WHERE route_id=$1 AND delivered_at IS NULL LIMIT 201) n`,
      values: [job.id], maxRows: 1 });
      if (Number(pending[0]?.count)+messages.length > 200) throw new AppControlError("gmail_routing_backlog", 503, "Notification backlog is full");
      await tx.query({ name: "gmail_route_stage_messages_v1", text: `INSERT INTO data.app_gmail_notifications(route_id,message_id)
        SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING`, values: [job.id, messages], maxRows: 0 });
      // Delivered identity retention is bounded in time and cleanup batch size.
      await tx.query({ name: "gmail_route_receipt_cleanup_v1", text: `DELETE FROM data.app_gmail_notifications WHERE (route_id,message_id) IN
        (SELECT route_id,message_id FROM data.app_gmail_notifications WHERE route_id=$1 AND delivered_at<now()-interval '30 days'
          ORDER BY delivered_at LIMIT 100)`, values: [job.id], maxRows: 0 });
    });
  }
  async delivered(job: GmailRoutingJob, id: string) {
    return this.transaction("delivered", tx => tx.query({ name: "gmail_route_delivered_v1", text: `UPDATE data.app_gmail_notifications
      SET delivered_at=now() WHERE route_id=$1 AND message_id=$2 AND EXISTS
        (SELECT 1 FROM data.app_gmail_routes WHERE route_id=$1 AND enabled AND lease_id=$3::uuid AND lease_until>now())`,
    values: [job.id, id, job.leaseId], maxRows: 0 }));
  }
  async finish(job: GmailRoutingJob, outcome: "done" | "continue" | "retry" | "blocked") {
    const retired=outcome==="blocked" ? await encryptSecretValue(this.material,`gmail-route:${job.id}`,"selection",1,
      JSON.stringify({...job.selection,oauthVerifier:"",refreshToken:undefined,pollToken:undefined})) : undefined;
    return this.transaction("finish", tx => tx.query({ name: "gmail_route_finish_v1", text: `UPDATE data.app_gmail_routes
      SET lease_id=NULL,lease_until=NULL,processed_version=CASE WHEN $3='done' THEN $4 ELSE processed_version END,
        last_verified_at=CASE WHEN $3='done' THEN now() ELSE last_verified_at END,
        next_poll_at=CASE WHEN notification_mode='poll' AND $3='done' THEN date_trunc('minute',now())+interval '1 minute' ELSE next_poll_at END,
        enabled=CASE WHEN $3='blocked' THEN false ELSE enabled END,
        encrypted_value_json=CASE WHEN $3='blocked' THEN $5::jsonb ELSE encrypted_value_json END,
        attempts=CASE WHEN $3 IN ('done','continue') THEN 0 ELSE attempts END,
        error_code=CASE WHEN $3 IN ('done','continue') THEN NULL WHEN $3='retry' AND attempts>=8 THEN 'paused' ELSE $3 END,
        available_at=now()+interval '15 seconds'*CASE WHEN $3 IN ('done','continue') THEN 1 ELSE least(60,power(2,attempts)) END,updated_at=now()
      WHERE route_id=$1 AND lease_id=$2::uuid AND lease_until>now()`, values: [job.id, job.leaseId, outcome, job.wakeVersion, retired ? JSON.stringify(retired):null], maxRows: 0 }));
  }
}
