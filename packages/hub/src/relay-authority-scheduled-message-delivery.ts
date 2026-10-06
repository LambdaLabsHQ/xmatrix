/**
 * Scheduled-message delivery owns the durable prepared -> appended -> delivered
 * transition. It depends only on message append and post-commit capabilities;
 * it does not receive RelayAuthority or the schedule lifecycle collaborator.
 */
import type { AppendMessageCommand } from "./product-message-command";
import type {
  AuthoritySqlRow,
  AuthoritySqlValue,
  AutomationExecutionRow,
  AutomationOccurrenceRow,
} from "./automation-occurrence-rows";
import { automationDatumFromPayload } from "./relay-authority-schedule-occurrence";
import type { ScheduleOccurrenceLifecycle } from "./relay-authority-schedule-occurrence";

/** The lines naming what fired an occurrence, or nothing when its cadence did. */
export function triggerNote(events: unknown): string {
  const lines = (Array.isArray(events) ? events : []).flatMap((event) => {
    const value = event && typeof event === "object" ? event as Record<string, unknown> : {};
    const summary = typeof value.summary === "string" ? value.summary.trim() : "";
    const url = typeof value.url === "string" && value.url.startsWith("https://") ? ` (${value.url})` : "";
    return summary ? [`- ${summary}${url}`] : [];
  });
  return lines.length ? `Triggered by:\n${lines.join("\n")}` : "";
}

export interface ScheduledMessagePostCommit {
  channelId: string;
  messageId: string;
  body: string;
  actorUserId: string;
  senderKind: "user" | "agent";
  senderId: string;
}

export interface ScheduledMessageDeliveryPort {
  readonly storage: DurableObjectStorage;
  first: <T extends AuthoritySqlRow>(
    query: string,
    ...bindings: AuthoritySqlValue[]
  ) => T | undefined;
  appendMessage(command: AppendMessageCommand): Promise<unknown>;
  schedulePostCommit(input: ScheduledMessagePostCommit): void;
}

export interface ScheduledMessageDelivery {
  dispatch(
    occurrence: AutomationOccurrenceRow,
    automation: AutomationExecutionRow,
    payload: Record<string, unknown>,
    schedule: ScheduleOccurrenceLifecycle,
  ): Promise<void>;
}

export async function dispatchScheduledMessageOccurrence(
  port: Pick<ScheduledMessageDeliveryPort, "appendMessage" | "schedulePostCommit">,
  occurrence: AutomationOccurrenceRow,
  automation: AutomationExecutionRow,
  payload: Record<string, unknown>,
  schedule: ScheduleOccurrenceLifecycle,
): Promise<void> {
  const input = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
    ? payload.input as Record<string, unknown> : undefined;
  const expression = automationDatumFromPayload(payload);
  const envRef = input?.envRef && typeof input.envRef === "object" && !Array.isArray(input.envRef)
    ? input.envRef as Record<string, unknown> : undefined;
  const actor = envRef?.actor && typeof envRef.actor === "object" && !Array.isArray(envRef.actor)
    ? envRef.actor as Record<string, unknown> : undefined;
  const senderKind = actor?.kind === "agent" ? "agent" : "user";
  const senderId = typeof actor?.id === "string" && actor.id ? actor.id : automation.owner_user_id;
  const message = payload.message && typeof payload.message === "object" &&
      !Array.isArray(payload.message)
    ? payload.message as Record<string, unknown>
    : undefined;
  const expressionV3 = payload.payloadVersion === 3 && expression?.kind === "text" &&
    expression.language === "natural-language";
  let body = expressionV3 && typeof expression?.text === "string"
    ? expression.text.trim()
    : typeof message?.body === "string" ? message.body.trim() : "";
  if ((!expressionV3 && payload.payloadVersion !== 2) || !body || !occurrence.message_id) {
    throw new Error("Scheduled evaluation payload is incomplete");
  }
  // An occurrence an event made due names the events, so its Run knows what changed.
  // The PostgreSQL occurrence carries them beside its SQL-row fields.
  const triggered = triggerNote((occurrence as unknown as { trigger_events?: unknown }).trigger_events);
  if (triggered) body = `${body}\n\n${triggered}`;
  const authorityRootUserId = typeof envRef?.authorityRootUserId === "string" &&
      envRef.authorityRootUserId
    ? envRef.authorityRootUserId
    : automation.owner_user_id;
  // A durable evaluation acts only while both captured principals remain live:
  // the effect actor is rechecked by appendMessage, and its Human authority
  // root is rechecked here. Neither side may keep the closure alive alone.
  await schedule.requireEvaluationAuthority(automation.channel_id, authorityRootUserId);
  const appMentions = Array.isArray(expression?.appMentions) ? expression.appMentions
    : Array.isArray(message?.appMentions) ? message.appMentions : undefined;
  // Prepared is the durable delivery-acceptance boundary. Automation edits only
  // cancel pending/leased occurrences, so a reentrant edit cannot commit a
  // message whose occurrence was concurrently cancelled.
  await schedule.markPrepared(occurrence, new Date().toISOString());
  await port.appendMessage({
    commandId: `scheduled:message-append:${occurrence.id}`.slice(0, 200),
    messageId: occurrence.message_id,
    channelId: automation.channel_id,
    body,
    principal: { kind: senderKind, id: senderId },
    authorityRootUserId,
    residual: {
      appMetadata: {
        xmatrixProvenance: "scheduled_automation",
        ...(expressionV3 ? { evalExpressionRef: expression.ref } : {}),
        automationId: automation.id,
        automationOccurrenceId: occurrence.id,
        scheduledFor: occurrence.scheduled_for,
        ...(appMentions?.length ? { appMentions } : {}),
      },
    },
  });
  const deliveredAt = new Date().toISOString();
  await schedule.finishMessage(occurrence, automation, deliveredAt);
  port.schedulePostCommit({
    channelId: automation.channel_id,
    messageId: occurrence.message_id,
    body,
    actorUserId: automation.owner_user_id,
    senderKind,
    senderId,
  });
}
