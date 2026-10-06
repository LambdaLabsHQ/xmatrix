import { storedIso as iso } from "./stored-values.js";
import { FIRST_MESSAGE_LAUNCH_HOLD_LIMIT_MS, FIRST_MESSAGE_LAUNCH_SEEN_MS, FIRST_MESSAGE_LAUNCH_WINDOW_MS, digestCanonicalCloneCborV1, type SerializedFirstMessageLaunchChoice } from "@xmatrix/protocol";
import type { FirstMessageLaunchChoiceRow } from "./first-message-launch-choice-row.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabasePlacementContext } from "./context.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";

/** Who decided a first message's launch: its author within the window, or Jev after it. */
export type FirstMessageLaunchChooser = "author" | "jev";

const HARNESS = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const harness = (value: string) => {
  if (!HARNESS.test(value)) throw new RegistrationAccessError("invalid_launch_choice", 400);
  return value;
};

/**
 * `data.first_message_launch_choices`: the one decision on whether, and which
 * harness, a new conversation's first message starts. The row's `choice` is
 * written once; the author's pick and Jev's reading race for it, so a message
 * never starts two Agents.
 */
export class PostgresFirstMessageLaunchChoiceRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly placement: DatabasePlacementContext) {}

  private transaction<T>(requestId: string, operation: string, callback: (tx: DatabaseTransaction) => Promise<T>) {
    return this.database.transaction({ requestId, operation, placement: this.placement }, callback);
  }

  /** Jev starts reading. The author's window has not begun: it starts with
   * Jev's reading (`recommend`), and until then only the hold limit applies. */
  async open(input: { requestId: string; channelId: string; messageId: string; authorUserId: string }): Promise<{ deadlineAt: string; chosenBy?: FirstMessageLaunchChooser }> {
    return this.transaction(input.requestId, "first-message-launch.open", async tx => {
      const source = await firstMessage(tx, this.placement.spaceId, input.channelId, input.messageId);
      if (!source) throw new RegistrationAccessError("launch_choice_unavailable", 409);
      const row = await insertChoice(tx, this.placement.spaceId, input.channelId, input.messageId, input.authorUserId, source.sent_at);
      return { deadlineAt: iso(row.deadline_at), ...(row.chosen_by ? { chosenBy: row.chosen_by as FirstMessageLaunchChooser } : {}) };
    });
  }

  /**
   * Jev's reading, written once. The author's window starts here: they see it
   * on their next refresh and then have the whole window. Until now the
   * deadline was the hold limit, which stays the cap.
   */
  async recommend(input: { requestId: string; channelId: string; messageId: string; harness?: string }): Promise<{ deadlineAt: string }> {
    return this.transaction(input.requestId, "first-message-launch.recommend", async tx => {
      const row = (await tx.query<FirstMessageLaunchChoiceRow>({ name: "first_message_launch_recommend_v2", text: `UPDATE data.first_message_launch_choices
        SET recommendation=$3,recommended_harness=$4,
          deadline_at=CASE WHEN choice IS NULL
            THEN LEAST(deadline_at,clock_timestamp()+make_interval(secs => $5::double precision/1000)) ELSE deadline_at END,
          updated_at=GREATEST(clock_timestamp(),created_at)
        WHERE channel_id=$1 AND message_id=$2 AND recommendation IS NULL RETURNING deadline_at`,
      values: [input.channelId, input.messageId, input.harness ? "start" : "none", input.harness ? harness(input.harness) : null,
        FIRST_MESSAGE_LAUNCH_WINDOW_MS + FIRST_MESSAGE_LAUNCH_SEEN_MS], maxRows: 1 }))[0]
        ?? (await tx.query<FirstMessageLaunchChoiceRow>({ name: "first_message_launch_recommend_read_v1", text: `SELECT deadline_at
          FROM data.first_message_launch_choices WHERE channel_id=$1 AND message_id=$2`,
        values: [input.channelId, input.messageId], maxRows: 1 }))[0];
      if (!row) throw new RegistrationAccessError("launch_choice_unavailable", 409);
      return { deadlineAt: iso(row.deadline_at) };
    });
  }

  /**
   * The author now sees Jev's reading: they get the whole window from this
   * moment, but never beyond the hold limit after sending.
   */
  async show(input: { requestId: string; channelId: string; messageId: string; actorUserId: string; body: string }): Promise<{ deadlineAt: string }> {
    const bodyHash = await digestCanonicalCloneCborV1(input.body);
    return this.transaction(input.requestId, "first-message-launch.show", async tx => {
      const source = await authorMessage(tx, this.placement.spaceId, input, bodyHash);
      await insertChoice(tx, this.placement.spaceId, input.channelId, input.messageId, input.actorUserId, source.sent_at);
      const row = (await tx.query<FirstMessageLaunchChoiceRow>({ name: "first_message_launch_show_v1", text: `UPDATE data.first_message_launch_choices
        SET deadline_at=GREATEST(deadline_at,LEAST(clock_timestamp()+make_interval(secs => $3::double precision/1000),
            $4::timestamptz+make_interval(secs => $5::double precision/1000))),
          updated_at=GREATEST(clock_timestamp(),created_at)
        WHERE channel_id=$1 AND message_id=$2 AND choice IS NULL RETURNING deadline_at`,
      values: [input.channelId, input.messageId, FIRST_MESSAGE_LAUNCH_WINDOW_MS, source.sent_at, FIRST_MESSAGE_LAUNCH_HOLD_LIMIT_MS],
      maxRows: 1 }))[0] ?? (await tx.query<FirstMessageLaunchChoiceRow>({ name: "first_message_launch_show_read_v1", text: `SELECT deadline_at
        FROM data.first_message_launch_choices WHERE channel_id=$1 AND message_id=$2`,
      values: [input.channelId, input.messageId], maxRows: 1 }))[0]!;
      return { deadlineAt: iso(row.deadline_at) };
    });
  }

  /**
   * Write the decision unless one is already written. The author may choose
   * only on their own message while nothing is decided; Jev decides only
   * once the window has closed, and a retry of its own decision is a win.
   */
  async claim(input: { requestId: string; channelId: string; messageId: string; by: FirstMessageLaunchChooser;
    actorUserId: string; harness?: string; body?: string }): Promise<{ claimed: boolean }> {
    const chosen = input.harness === undefined ? null : harness(input.harness);
    // The author's pick starts a Run on the body they hold; it must be the one stored.
    const bodyHash = input.by === "author" ? await digestCanonicalCloneCborV1(input.body ?? "") : undefined;
    return this.transaction(input.requestId, "first-message-launch.claim", async tx => {
      if (input.by === "author") {
        const source = await authorMessage(tx, this.placement.spaceId, input, bodyHash!);
        const row = await insertChoice(tx, this.placement.spaceId, input.channelId, input.messageId, input.actorUserId, source.sent_at);
        // A pick inside the window names a harness this Space can route now;
        // if not, nothing is written. A retry of a decision already written,
        // or a pick after the deadline, is answered by the row as it stands.
        if (chosen && row.choice === null && row.open) await requireRoutableHarness(tx, this.placement.spaceId, chosen);
      }
      const rows = await tx.query<FirstMessageLaunchChoiceRow>({ name: "first_message_launch_claim_v2", text: `UPDATE data.first_message_launch_choices
        SET choice=$3,chosen_harness=$4,chosen_by=$5,chosen_at=GREATEST(clock_timestamp(),created_at),
          updated_at=GREATEST(clock_timestamp(),created_at)
        WHERE channel_id=$1 AND message_id=$2 AND choice IS NULL AND author_user_id=$6
          AND (($5='author' AND clock_timestamp()<deadline_at)
            OR ($5='jev' AND deadline_at<=clock_timestamp()))
        RETURNING message_id`,
      values: [input.channelId, input.messageId, chosen ? "start" : "none", chosen, input.by, input.actorUserId], maxRows: 1 });
      if (rows[0]) return { claimed: true };
      const current = (await tx.query<FirstMessageLaunchChoiceRow>({ name: "first_message_launch_claim_read_v1", text: `SELECT
        choice,chosen_harness,chosen_by,deadline_at<=clock_timestamp() AS closed FROM data.first_message_launch_choices
        WHERE channel_id=$1 AND message_id=$2`, values: [input.channelId, input.messageId], maxRows: 1 }))[0];
      if (!current) throw new RegistrationAccessError("launch_choice_unavailable", 409);
      if (current.choice === null && !current.closed) throw new RegistrationAccessError("launch_choice_window_open", 409);
      return { claimed: current.chosen_by === input.by && current.chosen_harness === chosen };
    });
  }

  /** Jev could not read the message: nothing will be decided, and the message says why. */
  async fail(input: { requestId: string; channelId: string; messageId: string; failureCode: string }): Promise<void> {
    await this.transaction(input.requestId, "first-message-launch.fail", tx => tx.query({
      name: "first_message_launch_fail_v1", text: `UPDATE data.first_message_launch_choices
        SET failure_code=$3,updated_at=GREATEST(clock_timestamp(),created_at)
        WHERE channel_id=$1 AND message_id=$2 AND choice IS NULL AND failure_code IS NULL`,
      values: [input.channelId, input.messageId, input.failureCode.slice(0, 120)], maxRows: 0 }));
  }
}

/** The Channel's first message, from a Human, unedited and still shown. */
async function firstMessage(tx: DatabaseTransaction, spaceId: string, channelId: string, messageId: string) {
  return (await tx.query<FirstMessageLaunchChoiceRow>({ name: "first_message_launch_source_v1", text: `SELECT author_id,sent_at,body_hash
    FROM data.messages WHERE space_id=$1 AND channel_id=$2 AND message_id=$3 AND timeline_sequence=1
      AND author_kind='user' AND edited_at IS NULL AND recalled_at IS NULL AND deleted_at IS NULL`,
  values: [spaceId, channelId, messageId], maxRows: 1 }))[0];
}

/** The actor's own first message, holding exactly the body they sent. */
async function authorMessage(tx: DatabaseTransaction, spaceId: string,
  input: { channelId: string; messageId: string; actorUserId: string }, bodyHash: string) {
  const source = await firstMessage(tx, spaceId, input.channelId, input.messageId);
  if (!source || source.author_id !== input.actorUserId) throw new RegistrationAccessError("launch_choice_forbidden", 403);
  if (source.body_hash !== bodyHash) throw new RegistrationAccessError("launch_choice_stale", 409);
  return source;
}

async function insertChoice(tx: DatabaseTransaction, spaceId: string, channelId: string, messageId: string,
  authorUserId: string, sentAt: unknown) {
  await tx.query({ name: "first_message_launch_open_v1", text: `INSERT INTO data.first_message_launch_choices
    (channel_id,message_id,space_id,author_user_id,deadline_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5::timestamptz+make_interval(secs => $6::double precision/1000),clock_timestamp(),clock_timestamp())
    ON CONFLICT (channel_id,message_id) DO NOTHING`,
  values: [channelId, messageId, spaceId, authorUserId, sentAt, FIRST_MESSAGE_LAUNCH_HOLD_LIMIT_MS], maxRows: 0 });
  const row = (await tx.query<FirstMessageLaunchChoiceRow>({ name: "first_message_launch_open_read_v2", text: `SELECT deadline_at,choice,chosen_by,author_user_id,clock_timestamp()<deadline_at AS open
    FROM data.first_message_launch_choices WHERE channel_id=$1 AND message_id=$2 FOR UPDATE`,
  values: [channelId, messageId], maxRows: 1 }))[0]!;
  if (row.author_user_id !== authorUserId) throw new RegistrationAccessError("launch_choice_forbidden", 403);
  return row;
}

/** Some registration of this harness in the Space has an active grant, an
 * enabled policy, an owner who is still a member, and routing left on. */
async function requireRoutableHarness(tx: DatabaseTransaction, spaceId: string, chosen: string) {
  const rows = await tx.query<FirstMessageLaunchChoiceRow>({ name: "first_message_launch_routable_harness_v1", text: `SELECT 1
    FROM data.space_agent_registrations r
    JOIN data.space_members m ON m.space_id=r.space_id AND m.user_id=r.owner_user_id
    JOIN data.space_agent_registration_access a ON a.space_id=r.space_id AND a.owner_user_id=r.owner_user_id
      AND a.machine_id=r.machine_id AND a.harness=r.harness
    WHERE r.space_id=$1 AND r.harness=$2 AND a.grant_state='active' AND a.policy_state='enabled'
      AND COALESCE(r.configuration_json->'routing'->>'enabled','true')<>'false'
    LIMIT 1`, values: [spaceId, chosen], maxRows: 1 });
  if (!rows[0]) throw new RegistrationAccessError("launch_choice_harness_unavailable", 409);
}

/** Caller has checked the reader may read this Channel's history. */
export async function readFirstMessageLaunchChoices(tx: DatabaseTransaction, channelId: string,
  messageIds: readonly string[]): Promise<SerializedFirstMessageLaunchChoice[]> {
  if (!messageIds.length) return [];
  const rows = await tx.query<FirstMessageLaunchChoiceRow>({ name: "first_message_launch_read_v3", text: `SELECT choice.*,
    choice.choice IS NULL AND clock_timestamp()<choice.deadline_at AS open
    FROM data.first_message_launch_choices choice
    WHERE choice.channel_id=$1 AND choice.message_id=ANY($2::text[]) ORDER BY choice.message_id LIMIT 100`,
  values: [channelId, [...messageIds]], maxRows: 100 });
  return rows.map(row => ({
    channelId: String(row.channel_id), messageId: String(row.message_id), deadlineAt: iso(row.deadline_at), open: row.open === true,
    ...(row.recommendation === "start" ? { recommendation: { start: true as const, harness: String(row.recommended_harness) } }
      : row.recommendation === "none" ? { recommendation: { start: false as const } } : {}),
    ...(row.choice === "start" ? { choice: { start: true as const, harness: String(row.chosen_harness),
      by: row.chosen_by as FirstMessageLaunchChooser, at: iso(row.chosen_at) } }
      : row.choice === "none" ? { choice: { start: false as const, by: row.chosen_by as FirstMessageLaunchChooser, at: iso(row.chosen_at) } } : {}),
    ...(row.failure_code ? { failureCode: String(row.failure_code) } : {}),
  }));
}
