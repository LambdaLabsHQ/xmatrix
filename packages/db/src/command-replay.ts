import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";

/**
 * Command replays: the stored result a command id answers with when its
 * command is sent again. Every authority runs the same statements, so they
 * live here once; each caller passes its own statement name for telemetry and
 * its own error for a command id reused by a different request.
 */

interface CommandReplayKey {
  commandId: string;
  commandKind: string;
  requestDigest: string;
}

interface StoredCommandReplay {
  result: unknown;
  at: string;
  ttlMs: number;
}

function matchingReplay(rows: readonly QueryResultRow[], key: CommandReplayKey,
  reused: () => Error): Record<string, unknown> | null {
  if (!rows[0]) return null;
  if (rows[0].command_kind !== key.commandKind || rows[0].request_digest !== key.requestDigest) throw reused();
  return rows[0].result_json as Record<string, unknown>;
}

function expiry(input: StoredCommandReplay): string {
  return new Date(Date.parse(input.at) + input.ttlMs).toISOString();
}

/** A command id within an authority scope, such as a user or a Space. */
export interface ScopedCommandKey extends CommandReplayKey {
  scopeKind: string;
  scopeId: string;
}

/** The unexpired result stored for a scoped command, or null. */
export async function readScopedCommandReplay(tx: DatabaseTransaction, name: string,
  key: ScopedCommandKey, reused: () => Error): Promise<Record<string, unknown> | null> {
  return matchingReplay(await tx.query<QueryResultRow>({ name, text: `SELECT
    command_kind,request_digest,result_json FROM control.scoped_control_command_replays
    WHERE scope_kind=$1 AND scope_id=$2 AND command_id=$3 AND expires_at>clock_timestamp() LIMIT 1`,
  values: [key.scopeKind, key.scopeId, key.commandId], maxRows: 1 }), key, reused);
}

export async function storeScopedCommandReplay(tx: DatabaseTransaction, name: string,
  input: ScopedCommandKey & StoredCommandReplay): Promise<void> {
  await tx.query({ name, text: `INSERT INTO control.scoped_control_command_replays
    (scope_kind,scope_id,command_id,command_kind,request_digest,result_json,created_at,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, values: [input.scopeKind, input.scopeId, input.commandId,
    input.commandKind, input.requestDigest, JSON.stringify(input.result), input.at, expiry(input)], maxRows: 0 });
}

/** A command id within one Space, kept in the Space's own idempotency keys. */
export interface SpaceCommandKey extends CommandReplayKey {
  spaceId: string;
}

/** The unexpired result stored for a Space command, or null. */
export async function readSpaceCommandReplay(tx: DatabaseTransaction, name: string,
  key: SpaceCommandKey, reused: () => Error): Promise<Record<string, unknown> | null> {
  return matchingReplay(await tx.query<QueryResultRow>({ name, text: `SELECT
    command_kind,request_digest,result_json FROM data.idempotency_keys
    WHERE space_id=$1 AND idempotency_key=$2 AND expires_at>clock_timestamp() LIMIT 1`,
  values: [key.spaceId, key.commandId], maxRows: 1 }), key, reused);
}

/** Stores a Space command's result at the commit it made, if any. */
export async function storeSpaceCommandReplay(tx: DatabaseTransaction, name: string,
  input: SpaceCommandKey & StoredCommandReplay & { commitSequence: number | null }): Promise<void> {
  await tx.query({ name, text: `INSERT INTO data.idempotency_keys
    (space_id,idempotency_key,command_kind,request_digest,result_json,commit_sequence,created_at,expires_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`, values: [input.spaceId, input.commandId, input.commandKind,
    input.requestDigest, JSON.stringify(input.result), input.commitSequence, input.at, expiry(input)],
  maxRows: 0 });
}

/** Authority command results remain replayable for thirty days. */
export const COMMAND_REPLAY_TTL_MS = 30 * 24 * 60 * 60_000;
