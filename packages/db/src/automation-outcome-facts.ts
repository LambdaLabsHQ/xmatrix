import { ACTIVE_RUN_STATUS_SQL, CHANNEL_ACTIVITY_MESSAGE_KIND } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";

import { storedIso as iso } from "./stored-values.js";

/** Occurrences read per Automation, newest first (docs/design/pages-live-document.md §6.4). */
const AUTOMATION_OUTCOME_OCCURRENCES = 10;
/** Automations one read covers; a longer list is read in parts. */
export const AUTOMATION_OUTCOME_BATCH = 200;
/** A conversation's newest activity entries its pull requests are read from. */
const ACTIVITY_ENTRIES = 10;
/** The kind of the notice the Hub posts when an Agent asked for could not be launched. */
const LAUNCH_FAILURE_NOTICE_KIND = "xmatrix.system.runtime-failure";

/**
 * What one occurrence's own conversation records, from the authorities that
 * own each fact: the occurrence, its Agent launches and Runs, the page
 * revisions that name the conversation and its activity entries. Nothing here
 * is stored for this read.
 */
export interface AutomationOccurrenceFacts {
  automationId: string;
  scheduledFor: string;
  /** The occurrence's delivery status; cancelled occurrences are not read. */
  status: string;
  conversationId: string;
  /** A page revision (any but a purge) lists the conversation. */
  pageChanged: boolean;
  /** The distinct states of the conversation's Agent launches. */
  launchStates: string[];
  /** A Run in the conversation is still active. */
  runActive: boolean;
  /** The Hub posted a launch or runtime failure notice in the conversation. */
  failureNotice: boolean;
  /** Stored payload bundles of the conversation's newest activity entries, for the message codec. */
  activityPayloads: string[];
}

/*
 * One bounded statement on the Space's shard. The conversation id is the
 * scheduler's byte contract (migration 0200), computed once per occurrence.
 * Page revisions are found in one probe of their conversation GIN index for
 * every occurrence at once: a probe per occurrence lets the planner prefer a
 * scan it expects to stop early (migration 0239). Every other fact is an
 * index probe by that id: launches and Runs by Channel, failure notices and
 * activity entries by the partial message index. The message kinds are
 * literals so a generic plan can still use that partial index.
 */
const OCCURRENCE_FACTS_SQL = `WITH recent AS MATERIALIZED (
  SELECT a.automation_id,o.scheduled_for,o.status,
    data.automation_occurrence_conversation_id(o.occurrence_id) AS conversation_id
  FROM data.automations a
  JOIN data.channels c ON c.channel_id=a.channel_id AND c.space_id=$1
  CROSS JOIN LATERAL (SELECT x.occurrence_id,x.scheduled_for,x.status FROM data.automation_occurrences x
    WHERE x.automation_id=a.automation_id AND x.status<>'cancelled'
    ORDER BY x.scheduled_for DESC LIMIT ${AUTOMATION_OUTCOME_OCCURRENCES}) o
  WHERE a.automation_id=ANY($2::text[]) AND a.page_id IS NOT NULL
), edited AS MATERIALIZED (
  SELECT DISTINCT edit.conversation_id FROM data.page_revisions p
  CROSS JOIN LATERAL unnest(p.conversation_ids) AS edit(conversation_id)
  WHERE p.conversation_ids && ARRAY(SELECT conversation_id FROM recent) AND p.space_id=$1 AND p.kind<>'purge'
)
SELECT r.automation_id,r.scheduled_for,r.status,r.conversation_id,
  r.conversation_id IN (SELECT conversation_id FROM edited) AS page_changed,
  ARRAY(SELECT DISTINCT l.state FROM data.agent_launches l WHERE l.channel_id=r.conversation_id) AS launch_states,
  EXISTS (SELECT 1 FROM data.runs x WHERE x.channel_id=r.conversation_id
    AND x.status IN (${ACTIVE_RUN_STATUS_SQL})) AS run_active,
  EXISTS (SELECT 1 FROM data.messages m WHERE m.space_id=$1 AND m.channel_id=r.conversation_id
    AND m.message_kind='${LAUNCH_FAILURE_NOTICE_KIND}' AND m.deleted_at IS NULL) AS failure_notice,
  ARRAY(SELECT m.payload_bundle_base64 FROM data.messages m WHERE m.space_id=$1
    AND m.channel_id=r.conversation_id AND m.message_kind='${CHANNEL_ACTIVITY_MESSAGE_KIND}'
    AND m.deleted_at IS NULL AND m.recalled_at IS NULL AND m.payload_bundle_base64 IS NOT NULL
    ORDER BY m.timeline_sequence DESC LIMIT ${ACTIVITY_ENTRIES}) AS activity_payloads
FROM recent r ORDER BY r.automation_id,r.scheduled_for DESC`;

export function occurrenceFactsQuery(spaceId: string, automationIds: readonly string[]) {
  return { name: "automation_occurrence_facts_v1", text: OCCURRENCE_FACTS_SQL,
    values: [spaceId, [...automationIds]], maxRows: automationIds.length * AUTOMATION_OUTCOME_OCCURRENCES };
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function occurrenceFacts(row: QueryResultRow): AutomationOccurrenceFacts {
  return { automationId: String(row.automation_id), scheduledFor: iso(row.scheduled_for),
    status: String(row.status), conversationId: String(row.conversation_id),
    pageChanged: row.page_changed === true, launchStates: texts(row.launch_states),
    runActive: row.run_active === true, failureNotice: row.failure_notice === true,
    activityPayloads: texts(row.activity_payloads) };
}
