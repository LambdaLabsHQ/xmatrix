import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { erasePrivateAccountRows } from "./account-deletion-cleanup.js";
import { DetailedControlError } from "./control-error.js";

export class AccountDeletionError extends DetailedControlError {
  override name = "AccountDeletionError";
}
import type { AccountDeletionState, AccountDeletionBlocker } from "@xmatrix/protocol";
export type { AccountDeletionState, AccountDeletionBlocker } from "@xmatrix/protocol";
const LIMIT = 50;

/** Shared with the identity/Space admission path; never a name-based identity. */
async function lockAccountDeletion(tx: DatabaseTransaction, userId: string): Promise<void> {
  await tx.query({ name: "account_deletion_lock_v1",
    text: "SELECT pg_advisory_xact_lock(hashtextextended('account-deletion:' || $1,0))",
    values: [userId], maxRows: 1 });
}

/** A bounded read of authoritative rows on one physical shard, not directory hints. */
export async function accountDeletionBlockers(tx: DatabaseTransaction, userId: string): Promise<AccountDeletionBlocker[]> {
  const rows = await tx.query<QueryResultRow & AccountDeletionBlocker>({
    name: "account_deletion_blockers_v1",
    text: `SELECT DISTINCT kind,space_id AS "spaceId",name FROM (
      SELECT 'owned_space' AS kind,s.space_id,s.name FROM data.spaces s
        WHERE s.owner_user_id=$1 AND NOT EXISTS (
          SELECT 1 FROM data.space_deletions d WHERE d.space_id=s.space_id)
      UNION ALL
      SELECT 'membership',s.space_id,s.name FROM data.space_members m
        JOIN data.spaces s ON s.space_id=m.space_id WHERE m.user_id=$1 AND m.role<>'owner'
      UNION ALL
      SELECT 'subscription',b.space_id,s.name FROM data.space_billing_subscriptions b
        LEFT JOIN data.spaces s ON s.space_id=b.space_id
        WHERE b.billing_owner_user_id=$1 AND b.status NOT IN ('canceled','incomplete_expired')
      UNION ALL
      SELECT 'active_execution',NULL,NULL FROM data.runs r
        WHERE r.owner_user_id=$1 AND r.status IN ('starting','running')
      UNION ALL
      SELECT 'active_execution',a.space_id,NULL FROM control.registration_execution_allocations a
        WHERE a.owner_user_id=$1 AND a.state<>'released'
      UNION ALL
      SELECT 'active_execution',NULL,NULL FROM data.machine_daemon_commands m WHERE m.owner_user_id=$1
        AND m.status IN ('pending','leased') AND m.command_type IN ('spawn','harness_action','worktree_action','request_resolve')
      UNION ALL
      SELECT 'capacity',NULL,NULL WHERE (SELECT count(*) FROM (
        SELECT id FROM control.auth_sessions WHERE user_id=$1 UNION ALL SELECT id FROM control.auth_accounts WHERE user_id=$1 LIMIT 551) credentials)>550
    ) blockers LIMIT $2`, values: [userId, LIMIT + 1], maxRows: LIMIT + 1,
  });
  return rows.length > LIMIT ? [{ kind: "capacity" }] : rows.map(({ kind, spaceId, name }) => ({
    kind, ...(spaceId ? { spaceId } : {}), ...(name ? { name } : {}),
  }));
}

export class PostgresAccountDeletionRepository {
  constructor(private readonly directory: AuthorityDatabase,
    private readonly shards: readonly AuthorityDatabase[], private readonly shardIds: readonly string[]) {
    if (directory.cacheMode !== "disabled" || !shards.length || shards.length > 5 || shardIds.length !== shards.length || new Set(shardIds).size !== shardIds.length ||
        shards.some((db) => db.cacheMode !== "disabled")) {
      throw new AccountDeletionError("account_deletion_unavailable", 503, "Account deletion authority is unavailable");
    }
  }

  private async assertFleet(): Promise<void> {
    const rows=await this.directory.transaction({requestId:crypto.randomUUID(),operation:"account-deletion.fleet"},tx=>tx.query<{shard_id:string}>({
      name:"account_deletion_fleet_v1",text:"SELECT shard_id FROM control.postgres_shards WHERE state<>'retired' LIMIT 6",maxRows:6}));
    if(!rows.length || rows.some(row=>!this.shardIds.includes(row.shard_id))) throw new AccountDeletionError(
      "account_deletion_unavailable",503,"All account data shards must be available before deletion");
  }

  async preview(userId: string): Promise<{ blockers: AccountDeletionBlocker[] }> {
    await this.assertFleet();
    const results = await Promise.all(this.shards.map((db) => db.transaction(
      { requestId: crypto.randomUUID(), operation: "account-deletion.preview" },
      (tx) => accountDeletionBlockers(tx, userId))));
    return { blockers: results.flat() };
  }

  async begin(input: { userId: string; sessionId: string; email: string; requestId: string; receiptHash: string }) {
    if (!/^[a-zA-Z0-9_-]{1,300}$/.test(input.userId) || !/^[0-9a-f]{64}$/.test(input.receiptHash) ||
        !/^[0-9a-f-]{36}$/.test(input.requestId)) throw new AccountDeletionError("invalid_deletion_request", 400, "Invalid deletion request");
    await this.directory.transaction({ requestId: input.requestId, operation: "account-deletion.begin" }, async (tx) => {
      await lockAccountDeletion(tx, input.userId);
      const previous = await tx.query<{ state: AccountDeletionState; request_id: string; receipt_hash: string; fences_cleared: boolean }>({ name: "account_deletion_existing_v1",
        text: "SELECT state,request_id,receipt_hash,fences_cleared FROM control.account_deletion_requests WHERE user_id=$1 FOR UPDATE",
        values: [input.userId], maxRows: 1 });
      if (previous[0] && previous[0].state !== "blocked") {
        if (previous[0].request_id === input.requestId && previous[0].receipt_hash === input.receiptHash) return;
        throw new AccountDeletionError("account_deletion_in_progress", 409, "Account deletion is already in progress");
      }
      if (previous[0]?.state === "blocked" && !previous[0].fences_cleared) throw new AccountDeletionError(
        "account_deletion_retry",503,"The previous attempt is recovering. Try again shortly.",true);
      await assertDeletionSession(tx, input.userId, input.sessionId, input.email);
      await tx.query({ name: "account_deletion_begin_v1", text: `INSERT INTO control.account_deletion_requests
        (user_id,request_id,state,receipt_hash) VALUES ($1,$2,'preparing',$3)
        ON CONFLICT (user_id) DO UPDATE SET request_id=EXCLUDED.request_id,state='preparing',
          receipt_hash=EXCLUDED.receipt_hash,requested_at=clock_timestamp(),updated_at=clock_timestamp(),
          lease_token=NULL,lease_until=NULL,fences_cleared=false`, values: [input.userId,input.requestId,input.receiptHash], maxRows: 0 });
    });
  }

  async pending(): Promise<string[]> {
    return this.directory.transaction({ requestId: crypto.randomUUID(), operation: "account-deletion.pending" }, async (tx) =>
      (await tx.query<{ user_id: string }>({ name: "account_deletion_pending_v1", text: `SELECT user_id
        FROM control.account_deletion_requests WHERE (state IN ('preparing','committed') OR (state='blocked' AND NOT fences_cleared) OR (state='completed' AND avatar_sweep_after<=clock_timestamp() AND committed_at>clock_timestamp()-interval '1 day'))
          AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY updated_at LIMIT 2`, maxRows: 2 })).map(x => x.user_id));
  }

  async cancel(userId:string,requestId:string,receiptHash:string) {
    return this.directory.transaction({requestId:crypto.randomUUID(),operation:"account-deletion.cancel"},async tx=>{
      await lockAccountDeletion(tx,userId);
      return (await tx.query({name:"account_deletion_cancel_v1",text:`UPDATE control.account_deletion_requests
        SET state='blocked',lease_until=NULL,lease_token=NULL,fences_cleared=false,updated_at=clock_timestamp()
        WHERE user_id=$1 AND request_id=$2 AND receipt_hash=$3 AND state='preparing' RETURNING user_id`,
        values:[userId,requestId,receiptHash],maxRows:1})).length>0;
    });
  }

  async status(requestId: string, receiptHash: string) {
    return this.directory.transaction({ requestId: crypto.randomUUID(), operation: "account-deletion.status" }, async (tx) =>
      (await tx.query<{ state: AccountDeletionState }>({ name: "account_deletion_status_v1",
        text: "SELECT state FROM control.account_deletion_requests WHERE request_id=$1 AND receipt_hash=$2 LIMIT 1",
        values: [requestId,receiptHash], maxRows: 1 }))[0] ?? null);
  }

  /** Preparing fences are reversible; no private data is erased until commit. */
  async advance(userId: string, eraseAvatars: (userId: string) => Promise<boolean>) {
    await this.assertFleet();
    const lease = crypto.randomUUID();
    const job = await this.directory.transaction({ requestId: lease, operation: "account-deletion.claim" }, async (tx) =>
      (await tx.query<{ request_id: string; state: AccountDeletionState; avatar_cleanup_done: boolean }>({
        name: "account_deletion_claim_v1", text: `UPDATE control.account_deletion_requests
          SET lease_token=$2,lease_until=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp()
          WHERE user_id=$1 AND (state IN ('preparing','committed') OR (state='blocked' AND NOT fences_cleared) OR (state='completed' AND avatar_sweep_after<=clock_timestamp() AND committed_at>clock_timestamp()-interval '1 day'))
            AND (lease_until IS NULL OR lease_until<clock_timestamp())
          RETURNING request_id,state,avatar_cleanup_done`, values: [userId,lease], maxRows: 1 }))[0]);
    if (!job) return;
    try {
      if (job.state === "completed") {
        const empty = await eraseAvatars(userId);
        await this.directory.transaction({requestId:lease,operation:"account-deletion.avatar-sweep"},tx=>tx.query({
          name:"account_deletion_avatar_sweep_v1",text:"UPDATE control.account_deletion_requests SET avatar_sweep_after=clock_timestamp()+interval '15 minutes',avatar_cleanup_done=$3 WHERE user_id=$1 AND lease_token=$2",values:[userId,lease,empty],maxRows:0}));
        return;
      }
      if (job.state === "blocked") { await this.unfence(userId,job.request_id,lease); return; }
      if (job.state === "preparing") {
        for (const db of this.shards) await db.transaction({ requestId: lease, operation: "account-deletion.fence" }, async (tx) => {
          await lockAccountDeletion(tx,userId);
          await tx.query({ name: "account_deletion_fence_v1", text: `INSERT INTO data.account_deletion_fences(user_id,request_id)
            VALUES ($1,$2) ON CONFLICT(user_id) DO UPDATE SET request_id=EXCLUDED.request_id,expires_at=clock_timestamp()+interval '3 minutes'
            WHERE NOT data.account_deletion_fences.committed`, values: [userId,job.request_id], maxRows: 0 });
        });
        const { blockers } = await this.preview(userId);
        if (blockers.length) {
          const blocked = await this.directory.transaction({ requestId: lease, operation: "account-deletion.block" }, async (tx) =>
            (await tx.query({ name: "account_deletion_block_v1", text: `UPDATE control.account_deletion_requests SET state='blocked',
              lease_until=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND lease_token=$2 AND state='preparing' RETURNING user_id`,
              values: [userId,lease], maxRows: 1 })).length > 0);
          if (blocked) await this.unfence(userId,job.request_id,lease);
          return;
        }
        const committed = await this.directory.transaction({ requestId: lease, operation: "account-deletion.commit" }, async (tx) => {
          await lockAccountDeletion(tx,userId);
          const active = await tx.query({ name: "account_deletion_commit_lock_v1", text: `SELECT user_id FROM control.account_deletion_requests
            WHERE user_id=$1 AND lease_token=$2 AND state='preparing' AND lease_until>clock_timestamp() FOR UPDATE`, values: [userId,lease], maxRows: 1 });
          if (!active.length) return false;
          await tx.query({name:"account_deletion_profile_lock_v1",text:"SELECT id FROM control.auth_users WHERE id=$1 FOR UPDATE",values:[userId],maxRows:1});
          const counts = await tx.query<{ count: number }>({ name: "account_deletion_credentials_count_v1", text: `SELECT count(*)::int AS count FROM (
            SELECT id FROM control.auth_sessions WHERE user_id=$1 UNION ALL SELECT id FROM control.auth_accounts WHERE user_id=$1 LIMIT 551) entries`,
            values: [userId], maxRows: 1 });
          if (counts[0].count>550) throw new AccountDeletionError("account_deletion_capacity",409,"Revoke unused sign-in sessions first");
          await tx.query({ name: "account_deletion_retire_handle_v1", text: `INSERT INTO control.retired_human_handles(handle,user_id,retired_at)
            SELECT handle,id,clock_timestamp() FROM control.auth_users WHERE id=$1 AND handle IS NOT NULL ON CONFLICT DO NOTHING`, values:[userId],maxRows:0 });
          await tx.query({name:"account_deletion_verifications_v1",text:`DELETE FROM control.auth_verifications WHERE id IN (
            SELECT v.id FROM control.auth_verifications v JOIN control.auth_users u ON u.id=$1
            WHERE v.identifier=ANY(ARRAY['sign-in-otp-'||u.email,'email-verification-otp-'||u.email,'forget-password-otp-'||u.email]) LIMIT 500)`,values:[userId],maxRows:0});
          await tx.query({name:"account_deletion_directory_fence_v1",text:"UPDATE data.account_deletion_fences SET committed=true WHERE user_id=$1 AND request_id=$2",values:[userId,job.request_id],maxRows:0});
          await tx.query({ name: "account_deletion_auth_erase_v1", text:"DELETE FROM control.auth_users WHERE id=$1",values:[userId],maxRows:0 });
          await tx.query({ name:"account_deletion_commit_v1",text:`UPDATE control.account_deletion_requests SET state='committed',
            committed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE user_id=$1 AND lease_token=$2`,values:[userId,lease],maxRows:0 });
          return true;
        });
        if (!committed) return;
      }
      let complete = true;
      for (const db of this.shards) {
        const cleaned = await db.transaction({ requestId: lease, operation: "account-deletion.erase" }, async (tx) => {
          await lockAccountDeletion(tx,userId);
          await tx.query({ name: "account_deletion_commit_fence_v1", text:`INSERT INTO data.account_deletion_fences(user_id,request_id,committed) VALUES($1,$2,true)
            ON CONFLICT(user_id) DO UPDATE SET request_id=EXCLUDED.request_id,committed=true`,values:[userId,job.request_id],maxRows:0 });
          const done = await erasePrivateAccountRows(tx,userId);
          if (done) await tx.query({name:"account_deletion_cleaned_v1",text:"UPDATE data.account_deletion_fences SET cleaned=true WHERE user_id=$1 AND request_id=$2",values:[userId,job.request_id],maxRows:0});
          return done;
        });
        complete = complete && cleaned;
      }
      const avatars = job.avatar_cleanup_done || await eraseAvatars(userId);
      await this.directory.transaction({requestId:lease,operation:"account-deletion.finish"},async tx=>{
        await tx.query({name:"account_deletion_finish_v1",text:`UPDATE control.account_deletion_requests
          SET avatar_cleanup_done=$3,state=CASE WHEN $4 THEN 'completed' ELSE state END,
            completed_at=CASE WHEN $4 THEN COALESCE(completed_at,clock_timestamp()) ELSE completed_at END,
            avatar_sweep_after=CASE WHEN $4 THEN clock_timestamp()+interval '15 minutes' ELSE avatar_sweep_after END,
            lease_until=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND lease_token=$2`,values:[userId,lease,avatars,complete&&avatars],maxRows:0});
      });
    } finally {
      await this.directory.transaction({requestId:lease,operation:"account-deletion.release"},tx=>tx.query({
        name:"account_deletion_release_v1",text:"UPDATE control.account_deletion_requests SET lease_until=NULL WHERE user_id=$1 AND lease_token=$2",values:[userId,lease],maxRows:0}));
    }
  }

  private async unfence(userId:string,requestId:string,lease:string) {
    for (const db of this.shards) await db.transaction({requestId:lease,operation:"account-deletion.unfence"},async tx=>{
      await lockAccountDeletion(tx,userId);
      await tx.query({name:"account_deletion_unfence_v1",text:"DELETE FROM data.account_deletion_fences WHERE user_id=$1 AND request_id=$2 AND NOT committed",values:[userId,requestId],maxRows:0});
    });
    await this.directory.transaction({requestId:lease,operation:"account-deletion.unfenced"},tx=>tx.query({
      name:"account_deletion_unfenced_v1",text:"UPDATE control.account_deletion_requests SET fences_cleared=true WHERE user_id=$1 AND request_id=$2 AND state='blocked' AND lease_token=$3",values:[userId,requestId,lease],maxRows:0}));
  }

  async revoked(userId: string): Promise<boolean> {
    return this.directory.transaction({ requestId: crypto.randomUUID(), operation: "account-deletion.revocation" }, async (tx) =>
      (await tx.query({ name: "account_deletion_revoked_v1",
        text: "SELECT 1 FROM control.account_deletion_requests WHERE user_id=$1 AND state IN ('committed','completed')",
        values: [userId], maxRows: 1 })).length !== 0);
  }
}

/** A fresh login is required; merely refreshing a JWT never makes a session fresh. */
async function assertDeletionSession(tx: DatabaseTransaction, userId: string, sessionId: string, email: string): Promise<void> {
  const rows = await tx.query<{ email: string }>({ name: "account_deletion_fresh_session_v1",
    text: `SELECT u.email FROM control.auth_users u JOIN control.auth_sessions s ON s.user_id=u.id
      WHERE u.id=$1 AND s.id=$2 AND s.expires_at>clock_timestamp()
        AND s.created_at>clock_timestamp()-interval '10 minutes' AND s.created_at<=clock_timestamp()+interval '1 minute' FOR UPDATE OF u`,
    values: [userId, sessionId], maxRows: 1 });
  if (!rows[0]) throw new AccountDeletionError("account_deletion_reauthenticate", 409, "Sign out and sign in again before deleting your account");
  if (rows[0].email.toLowerCase() !== email.trim().toLowerCase()) throw new AccountDeletionError(
    "account_deletion_confirmation", 400, "Enter your account email and DELETE to confirm");
  const count = await tx.query<{ sessions: number; accounts: number }>({ name: "account_deletion_auth_size_v1",
    text: `SELECT (SELECT count(*)::int FROM (SELECT 1 FROM control.auth_sessions WHERE user_id=$1 LIMIT 501) s) sessions,
      (SELECT count(*)::int FROM (SELECT 1 FROM control.auth_accounts WHERE user_id=$1 LIMIT 51) a) accounts`,
    values: [userId], maxRows: 1 });
  if (count[0].sessions > 500 || count[0].accounts > 50) throw new AccountDeletionError(
    "account_deletion_capacity", 409, "Revoke unused sign-in sessions before deleting your account");
}
