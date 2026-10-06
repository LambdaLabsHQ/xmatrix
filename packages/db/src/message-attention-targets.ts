import type { QueryResultRow } from "pg";
import { MENTION_BROADCAST_NAMES, canonicalMentionToken, mentionAddressTokens,
  scanMentionAddresses, filterOperationalMentions , utf8ByteLength } from "@xmatrix/protocol";
import type { DatabaseTransaction } from "./contracts.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import { MessageAuthorityError } from "./message-authority-error.js";

export const MAX_ATTENTION_TARGETS = 1_000;

interface AttentionCandidateRow extends QueryResultRow {
  subject_id: string;
  name: string;
  handle?: string | null;
  instance_ordinal?: string | number | null;
  total_count: string | number;
}

/** The caller authorizes the message writer in this same transaction. This
 * boundary resolves only currently readable recipients, including exact
 * Channel-local Instance aliases, and never chooses the first repeated name. */
export async function atomicAttentionTargets(
  transaction: DatabaseTransaction,
  input: { spaceId: string; channelId: string; body: string; senderSubjectId: string },
): Promise<Map<string, "mention" | "broadcast" | "reply">> {
  if (utf8ByteLength(input.body) > 64 * 1024) throw new MessageAuthorityError(
    "invalid_command", 400, "attentionBody is invalid",
  );
  const targets = new Map<string, "mention" | "broadcast" | "reply">();
  if (!/[@＠]/u.test(input.body)) return targets;
  // This is only a bounded query prefilter. The shared mention scanner and
  // current Channel/Instance/registration joins below still decide actual addresses.
  const ordinals = [...new Set([...input.body.matchAll(/:([1-9]\d{0,15})/gu)]
    .map(match => match[1]!).filter(value => Number.isSafeInteger(Number(value))))];
  if (ordinals.length > MAX_ATTENTION_TARGETS) throw new MessageAuthorityError(
    "attention_target_limit_exceeded", 400, "Instance addresses exceed 1000");
  const rows = await transaction.query<AttentionCandidateRow>({
    name: "message_attention_candidates_v5",
    text: `SELECT candidate.subject_id,candidate.name,candidate.handle,candidate.instance_ordinal,COUNT(*) OVER () AS total_count FROM (
      SELECT 'user:'||m.user_id AS subject_id,
        COALESCE(NULLIF(h.name,''),m.display_name,'') AS name, h.handle,NULL::bigint AS instance_ordinal
        FROM data.channels c JOIN data.space_members m ON m.space_id=c.space_id
        LEFT JOIN control.auth_users h ON h.id=m.user_id
       WHERE c.space_id=$1 AND c.channel_id=$2
        AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
          principalKindSql: "'user'", principalIdSql: "m.user_id" })}
      UNION ALL
      SELECT 'agent:'||i.instance_id AS subject_id,
        registration.display_name||':'||i.channel_instance_id AS name,
        NULL::text AS handle,i.channel_instance_id AS instance_ordinal
        FROM data.channels c JOIN data.instances i ON i.channel_id=c.channel_id
        JOIN data.run_agent_registrations binding ON binding.run_id=i.run_id AND binding.space_id=c.space_id
        JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
          AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
          AND registration.harness=binding.harness
       WHERE c.space_id=$1 AND c.channel_id=$2 AND i.channel_instance_id=ANY($3::bigint[])
        AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
          principalKindSql: "'agent'", principalIdSql: "i.instance_id" })}
    ) candidate ORDER BY candidate.subject_id LIMIT 10000`,
    values: [input.spaceId, input.channelId, ordinals], maxRows: 10_000,
  });
  if (Number(rows[0]?.total_count ?? rows.length) > 10_000) throw new MessageAuthorityError(
    "attention_candidate_limit_exceeded", 409, "Attention candidates exceed 10000",
  );
  const owners = new Map<string, string | null>();
  const tokenSubjects = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const name of [row.name, row.handle]) {
      const token = canonicalMentionToken(name ?? "");
      if (!token) continue;
      const subjects = tokenSubjects.get(token) ?? new Set();
      subjects.add(row.subject_id);
      tokenSubjects.set(token, subjects);
      const prior = owners.get(token);
      owners.set(token, prior === undefined || prior === row.subject_id ? row.subject_id : null);
    }
  }
  const broadcastTokens = new Set(MENTION_BROADCAST_NAMES);
  const tokens = mentionAddressTokens([...owners.keys(), ...MENTION_BROADCAST_NAMES]);
  for (const match of filterOperationalMentions(input.body, scanMentionAddresses(input.body, tokens))) {
    // An unknown/mismatched ordinal must not fall back to a broader name or
    // broadcast. Valid instance aliases above win by the longest-token rule.
    if (/^:\d/u.test(input.body.slice(match.start + 1 + match.token.length))) continue;
    if (broadcastTokens.has(match.token)) {
      for (const row of rows) {
        if (row.subject_id !== input.senderSubjectId) targets.set(row.subject_id, "broadcast");
      }
      continue;
    }
    const subjectId = owners.get(match.token);
    if (subjectId === null) {
      const subjects = [...(tokenSubjects.get(match.token) ?? [])];
      if (subjects.length > 0 && subjects.every(subject => subject.startsWith("agent:"))) continue;
      throw new MessageAuthorityError(
        "attention_target_ambiguous", 409, "Mention name is not unique in this Channel; use a unique handle",
      );
    }
    if (subjectId && subjectId !== input.senderSubjectId && targets.get(subjectId) !== "broadcast") {
      targets.set(subjectId, "mention");
    }
  }
  if (targets.size > MAX_ATTENTION_TARGETS) throw new MessageAuthorityError(
    "attention_target_limit_exceeded", 400, "Attention targets exceed 1000",
  );
  return targets;
}
