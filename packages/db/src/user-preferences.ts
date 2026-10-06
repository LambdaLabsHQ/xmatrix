import type { QueryResultRow } from "pg";
import { sha256Hex , utf8ByteLength, legacyCanonicalJson as canonicalJson } from "@xmatrix/protocol";

import type { DatabaseRequestContext } from "./context.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { DatabaseContractError } from "./errors.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import { ControlError } from "./control-error.js";

const MAX_SCOPE_BYTES = 300;
const MAX_PINNED_CHANNELS = 200;
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const FOLLOW_UP_SCHEDULES = new Set(["off", "daily", "weekdays", "weekly"]);
const LOCALE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export class UserPreferenceConflictError extends ControlError {
  override name = "UserPreferenceConflictError";

  constructor(message: string) {
    super("user_preference_conflict", 409, message);
  }
}

export class UserPreferenceAuthorizationError extends ControlError {
  override name = "UserPreferenceAuthorizationError";

  constructor(message: string) {
    super("user_preference_forbidden", 403, message);
  }
}

export interface UserSpaceLocalePreference {
  spaceId: string;
  displayLocale: string | null;
  editingLocale: string | null;
  version: number;
}

export interface UserSpaceChannelViewPreference {
  spaceId: string;
  followUpReviewSchedule: "off" | "daily" | "weekdays" | "weekly";
  pinnedChannelIds: string[];
  version: number;
}

export interface UpdateUserSpaceLocalePreference {
  commandId: string;
  spaceId: string;
  userId: string;
  expectedVersion: number;
  at: string;
  displayLocale?: string | null;
  editingLocale?: string | null;
}

export interface UpdateUserSpaceChannelViewPreference {
  commandId: string;
  spaceId: string;
  userId: string;
  expectedVersion: number;
  at: string;
  followUpReviewSchedule?: "off" | "daily" | "weekdays" | "weekly";
  pinnedChannelIds?: string[];
}

export interface UserPreferenceWriteResult {
  version: number;
  reused: boolean;
}

interface LocaleRow extends QueryResultRow {
  display_locale: string | null;
  editing_locale: string | null;
  version: string | number;
  created_at?: Date | string;
}

interface ChannelViewRow extends QueryResultRow {
  follow_up_review_schedule: string;
  pinned_channel_ids_json: unknown[];
  version: string | number;
  created_at?: Date | string;
}

interface IdempotencyRow extends QueryResultRow {
  command_kind: string;
  request_digest: string;
  result_json: { version?: unknown };
}

function boundedText(value: unknown, field: string, maximum = MAX_SCOPE_BYTES): string {
  if (typeof value !== "string") throw new DatabaseContractError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || utf8ByteLength(normalized) > maximum) {
    throw new DatabaseContractError(`${field} is invalid`);
  }
  return normalized;
}

function version(value: unknown, field = "version"): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DatabaseContractError(`${field} is invalid`);
  }
  return parsed;
}

function timestamp(value: string): string {
  const at = boundedText(value, "at", 64);
  const millis = Date.parse(at);
  if (!Number.isFinite(millis)) throw new DatabaseContractError("at is invalid");
  return new Date(millis).toISOString();
}

function requirePlacement(context: DatabaseRequestContext, spaceId: string): void {
  if (!context.placement || context.placement.spaceId !== spaceId) {
    throw new DatabaseContractError("user preference query requires matching Space placement");
  }
}

async function requireMembership(
  transaction: DatabaseTransaction,
  spaceId: string,
  userId: string,
): Promise<string> {
  const rows = await transaction.query<QueryResultRow & { role: string }>({
    name: "user_preference_membership_v1",
    text: `SELECT role FROM data.space_members
      WHERE space_id = $1 AND user_id = $2 LIMIT 1`,
    values: [spaceId, userId], maxRows: 1,
  });
  const role = rows[0]?.role;
  if (!role) throw new UserPreferenceAuthorizationError("Space membership required");
  return role;
}

function normalizedPinnedChannelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_PINNED_CHANNELS) break;
  }
  return result;
}

function validatedPinnedChannelIds(value: unknown): string[] {
  const normalized = normalizedPinnedChannelIds(value);
  if (JSON.stringify(normalized) !== JSON.stringify(value)) {
    throw new DatabaseContractError("pinnedChannelIds is invalid");
  }
  return normalized;
}

async function readableChannelIds(
  transaction: DatabaseTransaction,
  spaceId: string,
  userId: string,
  channelIds: readonly string[],
): Promise<Set<string>> {
  if (channelIds.length === 0) return new Set();
  const unique = [...new Set(channelIds)].slice(0, MAX_PINNED_CHANNELS);
  const rows = await transaction.query<QueryResultRow & { channel_id: string }>({
    name: "user_preference_visible_channels_v3",
    text: `SELECT channel.channel_id
      FROM data.channels channel
      WHERE channel.space_id=$1 AND channel.channel_id=ANY($3::text[])
        AND ${channelCapabilityPredicate({ capability: "preference_update", channelAlias: "channel",
          principalKindSql: "'user'", principalIdSql: "$2" })}`,
    values: [spaceId, userId, unique], maxRows: unique.length,
  });
  return new Set(rows.map((row) => row.channel_id));
}

/** The pins the user may still read. */
async function visiblePinnedChannelIds(
  transaction: DatabaseTransaction,
  spaceId: string,
  userId: string,
  rawPinnedChannelIds: unknown,
): Promise<string[]> {
  const pinnedChannelIds = normalizedPinnedChannelIds(rawPinnedChannelIds);
  const readable = await readableChannelIds(transaction, spaceId, userId, pinnedChannelIds);
  return pinnedChannelIds.filter((channelId) => readable.has(channelId));
}


async function sha256(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

async function lockPreference(
  transaction: DatabaseTransaction,
  spaceId: string,
  userId: string,
  kind: string,
): Promise<void> {
  await transaction.query({
    name: "user_preference_aggregate_lock_v1",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) AS locked",
    values: [JSON.stringify([kind, spaceId, userId])],
    maxRows: 1,
  });
}

async function priorResult(
  transaction: DatabaseTransaction,
  input: { commandId: string; spaceId: string },
  commandKind: string,
  requestDigest: string,
  at: string,
): Promise<UserPreferenceWriteResult | undefined> {
  await transaction.query({
    name: "user_preference_idempotency_lock_v1",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) AS locked",
    values: [JSON.stringify(["idempotency", input.spaceId, input.commandId])],
    maxRows: 1,
  });
  await transaction.query({
    name: "user_preference_expired_idempotency_delete_v1",
    text: `DELETE FROM data.idempotency_keys
      WHERE space_id = $1 AND idempotency_key = $2 AND expires_at <= $3::timestamptz
      RETURNING idempotency_key`,
    values: [input.spaceId, input.commandId, at],
    maxRows: 1,
  });
  const rows = await transaction.query<IdempotencyRow>({
    name: "user_preference_idempotency_read_v1",
    text: `SELECT command_kind, request_digest, result_json
      FROM data.idempotency_keys
      WHERE space_id = $1 AND idempotency_key = $2
      FOR UPDATE`,
    values: [input.spaceId, input.commandId],
    maxRows: 1,
  });
  const row = rows[0];
  if (!row) return undefined;
  if (row.command_kind !== commandKind || row.request_digest !== requestDigest) {
    throw new UserPreferenceConflictError("idempotency key was used for another request");
  }
  return { version: version(row.result_json?.version), reused: true };
}

async function recordResult(
  transaction: DatabaseTransaction,
  input: { commandId: string; spaceId: string },
  commandKind: string,
  requestDigest: string,
  at: string,
  result: UserPreferenceWriteResult,
): Promise<void> {
  const expiresAt = new Date(Date.parse(at) + IDEMPOTENCY_TTL_MS).toISOString();
  await transaction.query({
    name: "user_preference_idempotency_insert_v1",
    text: `INSERT INTO data.idempotency_keys
      (space_id, idempotency_key, command_kind, request_digest, result_json,
       commit_sequence, created_at, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, NULL, $6::timestamptz, $7::timestamptz)
      RETURNING idempotency_key`,
    values: [input.spaceId, input.commandId, commandKind, requestDigest,
      JSON.stringify({ version: result.version }), at, expiresAt],
    maxRows: 1,
  });
}

function localePreference(spaceId: string, row: LocaleRow | undefined): UserSpaceLocalePreference {
  return {
    spaceId,
    displayLocale: typeof row?.display_locale === "string" ? row.display_locale : null,
    editingLocale: typeof row?.editing_locale === "string" ? row.editing_locale : null,
    version: row ? version(row.version) : 0,
  };
}

function channelViewPreference(
  spaceId: string,
  row: ChannelViewRow | undefined,
): UserSpaceChannelViewPreference {
  const pinnedChannelIds = Array.isArray(row?.pinned_channel_ids_json)
    ? row.pinned_channel_ids_json.filter((id): id is string => typeof id === "string")
    : [];
  const schedule = row?.follow_up_review_schedule;
  return {
    spaceId,
    followUpReviewSchedule: schedule === "daily" || schedule === "weekdays" || schedule === "weekly"
      ? schedule
      : "off",
    pinnedChannelIds,
    version: row ? version(row.version) : 0,
  };
}

interface PreferenceCommand {
  commandId: string;
  spaceId: string;
  userId: string;
  expectedVersion: number;
  at: string;
}

function preferenceCommand<Raw extends { commandId: string; spaceId: string; userId: string;
  expectedVersion: number; at: string }>(raw: Raw): Raw & PreferenceCommand {
  return {
    ...raw,
    commandId: boundedText(raw.commandId, "commandId"),
    spaceId: boundedText(raw.spaceId, "spaceId"),
    userId: boundedText(raw.userId, "userId"),
    expectedVersion: version(raw.expectedVersion, "expectedVersion"),
    at: timestamp(raw.at),
  };
}

export class PostgresUserPreferenceRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") {
      throw new DatabaseContractError("user preference authority requires a cache-disabled database");
    }
  }

  async readLocale(
    context: DatabaseRequestContext,
    spaceIdValue: string,
    userIdValue: string,
  ): Promise<UserSpaceLocalePreference> {
    return this.readPreference(context, spaceIdValue, userIdValue, async (transaction, spaceId, userId) => {
      const rows = await transaction.query<LocaleRow>({
        name: "user_space_locale_preference_read_v1",
        text: `SELECT display_locale, editing_locale, version
          FROM data.user_space_locale_preferences
          WHERE space_id = $1 AND user_id = $2`,
        values: [spaceId, userId],
        maxRows: 1,
      });
      return localePreference(spaceId, rows[0]);
    });
  }

  async updateLocale(
    context: DatabaseRequestContext,
    raw: UpdateUserSpaceLocalePreference,
  ): Promise<UserPreferenceWriteResult> {
    const displayLocale = raw.displayLocale === undefined || raw.displayLocale === null
      ? raw.displayLocale : boundedText(raw.displayLocale, "displayLocale", 32);
    const editingLocale = raw.editingLocale === undefined || raw.editingLocale === null
      ? raw.editingLocale : boundedText(raw.editingLocale, "editingLocale", 32);
    if (displayLocale !== undefined && displayLocale !== null && !LOCALE_TAG.test(displayLocale) ||
        editingLocale !== undefined && editingLocale !== null && !LOCALE_TAG.test(editingLocale)) {
      throw new DatabaseContractError("locale preference is invalid");
    }
    const input = {
      ...preferenceCommand(raw),
      ...(displayLocale === undefined ? {} : { displayLocale }),
      ...(editingLocale === undefined ? {} : { editingLocale }),
    };
    requirePlacement(context, input.spaceId);
    if (input.displayLocale === undefined && input.editingLocale === undefined) {
      throw new DatabaseContractError("a locale preference change is required");
    }
    return this.writePreference<LocaleRow>(context, input, {
      commandKind: "user_space_locale_preference_update",
      aggregate: "locale",
      label: "locale preference",
      current: {
        name: "user_space_locale_preference_for_update_v1",
        text: `SELECT display_locale, editing_locale, version, created_at
          FROM data.user_space_locale_preferences
          WHERE space_id = $1 AND user_id = $2 FOR UPDATE`,
      },
    }, async (transaction, current, next) => {
      const displayLocale = input.displayLocale === undefined
        ? current?.display_locale ?? null
        : input.displayLocale;
      const editingLocale = input.editingLocale === undefined
        ? current?.editing_locale ?? null
        : input.editingLocale;
      if (current && displayLocale === current.display_locale && editingLocale === current.editing_locale) {
        throw new UserPreferenceConflictError("locale preference does not change");
      }
      return transaction.query<{ version: string | number }>({
        name: "user_space_locale_preference_upsert_v1",
        text: `INSERT INTO data.user_space_locale_preferences
          (space_id, user_id, display_locale, editing_locale, version, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz)
          ON CONFLICT (space_id, user_id) DO UPDATE SET
            display_locale = EXCLUDED.display_locale,
            editing_locale = EXCLUDED.editing_locale,
            version = EXCLUDED.version,
            updated_at = EXCLUDED.updated_at
          WHERE data.user_space_locale_preferences.version = $7
          RETURNING version`,
        values: [input.spaceId, input.userId, displayLocale, editingLocale, next,
          input.at, input.expectedVersion],
        maxRows: 1,
      });
    });
  }

  async readChannelView(
    context: DatabaseRequestContext,
    spaceIdValue: string,
    userIdValue: string,
  ): Promise<UserSpaceChannelViewPreference> {
    return this.readPreference(context, spaceIdValue, userIdValue, async (transaction, spaceId, userId) => {
      const rows = await transaction.query<ChannelViewRow>({
        name: "user_space_channel_view_preference_read_v2",
        text: `SELECT follow_up_review_schedule, pinned_channel_ids_json, version
          FROM data.user_space_channel_view_preferences
          WHERE space_id = $1 AND user_id = $2`,
        values: [spaceId, userId],
        maxRows: 1,
      });
      const value = channelViewPreference(spaceId, rows[0]);
      return { ...value,
        pinnedChannelIds: await visiblePinnedChannelIds(transaction, spaceId, userId, value.pinnedChannelIds) };
    });
  }

  async updateChannelView(
    context: DatabaseRequestContext,
    raw: UpdateUserSpaceChannelViewPreference,
  ): Promise<UserPreferenceWriteResult> {
    const input = {
      ...preferenceCommand(raw),
      ...(raw.pinnedChannelIds === undefined
        ? {} : { pinnedChannelIds: validatedPinnedChannelIds(raw.pinnedChannelIds) }),
    };
    requirePlacement(context, input.spaceId);
    if (input.followUpReviewSchedule === undefined && input.pinnedChannelIds === undefined) {
      throw new DatabaseContractError("a channel view preference change is required");
    }
    if (input.followUpReviewSchedule !== undefined &&
        !FOLLOW_UP_SCHEDULES.has(input.followUpReviewSchedule)) {
      throw new DatabaseContractError("followUpReviewSchedule is invalid");
    }
    return this.writePreference<ChannelViewRow>(context, input, {
      commandKind: "user_space_channel_view_preference_update",
      aggregate: "channel-view",
      label: "channel view preference",
      current: {
        name: "user_space_channel_view_preference_for_update_v2",
        text: `SELECT follow_up_review_schedule, pinned_channel_ids_json, version, created_at
          FROM data.user_space_channel_view_preferences
          WHERE space_id = $1 AND user_id = $2 FOR UPDATE`,
      },
    }, async (transaction, current, next) => {
      const schedule = input.followUpReviewSchedule === undefined
        ? current?.follow_up_review_schedule ?? "off"
        : input.followUpReviewSchedule;
      const pinned = input.pinnedChannelIds === undefined
        ? current?.pinned_channel_ids_json ?? []
        : input.pinnedChannelIds;
      const visible = await visiblePinnedChannelIds(transaction, input.spaceId, input.userId, pinned);
      if (canonicalJson(visible) !== canonicalJson(normalizedPinnedChannelIds(pinned))) {
        throw new UserPreferenceAuthorizationError(
          "Channel view preference includes a Channel the user cannot read",
        );
      }
      if (current && schedule === current.follow_up_review_schedule &&
          canonicalJson(pinned) === canonicalJson(current.pinned_channel_ids_json)) {
        throw new UserPreferenceConflictError("channel view preference does not change");
      }
      return transaction.query<{ version: string | number }>({
        name: "user_space_channel_view_preference_upsert_v2",
        text: `INSERT INTO data.user_space_channel_view_preferences
          (space_id, user_id, follow_up_review_schedule,
           pinned_channel_ids_json, version, created_at, updated_at)
          VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $6::timestamptz)
          ON CONFLICT (space_id, user_id) DO UPDATE SET
            follow_up_review_schedule = EXCLUDED.follow_up_review_schedule,
            pinned_channel_ids_json = EXCLUDED.pinned_channel_ids_json,
            version = EXCLUDED.version,
            updated_at = EXCLUDED.updated_at
          WHERE data.user_space_channel_view_preferences.version = $7
          RETURNING version`,
        values: [input.spaceId, input.userId, schedule,
          JSON.stringify(pinned), next, input.at, input.expectedVersion],
        maxRows: 1,
      });
    });
  }

  /** Runs `read` for a member of the Space, in the Space's placement. */
  private async readPreference<T>(context: DatabaseRequestContext, spaceIdValue: string, userIdValue: string,
    read: (transaction: DatabaseTransaction, spaceId: string, userId: string) => Promise<T>): Promise<T> {
    const spaceId = boundedText(spaceIdValue, "spaceId");
    const userId = boundedText(userIdValue, "userId");
    requirePlacement(context, spaceId);
    return this.database.transaction(context, async (transaction) => {
      await requireMembership(transaction, spaceId, userId);
      return read(transaction, spaceId, userId);
    });
  }

  /**
   * One optimistic preference write: replays a repeated command, locks the
   * user's preference, requires its version to be `expectedVersion`, and has
   * `write` store version `expectedVersion + 1`.
   */
  private async writePreference<Row extends QueryResultRow & { version: string | number }>(
    context: DatabaseRequestContext,
    input: PreferenceCommand,
    preference: { commandKind: string; aggregate: string; label: string; current: { name: string; text: string } },
    write: (transaction: DatabaseTransaction, current: Row | undefined, next: number)
      => Promise<readonly { version: string | number }[]>,
  ): Promise<UserPreferenceWriteResult> {
    const { commandKind } = preference;
    const requestDigest = await sha256({ commandKind, ...input });
    return this.database.transaction(context, async (transaction) => {
      await requireMembership(transaction, input.spaceId, input.userId);
      const reused = await priorResult(transaction, input, commandKind, requestDigest, input.at);
      if (reused) return reused;
      await lockPreference(transaction, input.spaceId, input.userId, preference.aggregate);
      const rows = await transaction.query<Row>({ ...preference.current,
        values: [input.spaceId, input.userId], maxRows: 1 });
      const current = rows[0];
      if ((!current && input.expectedVersion !== 0) ||
          (current && version(current.version) !== input.expectedVersion)) {
        throw new UserPreferenceConflictError(`${preference.label} version changed`);
      }
      const next = input.expectedVersion + 1;
      const written = await write(transaction, current, next);
      if (written.length !== 1 || version(written[0].version) !== next) {
        throw new UserPreferenceConflictError(`${preference.label} version changed`);
      }
      const result = { version: next, reused: false };
      await recordResult(transaction, input, commandKind, requestDigest, input.at, result);
      return result;
    });
  }
}
