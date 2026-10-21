import { COMMAND_RESULT_ANNOTATION_NAMESPACE, type AgentControlOutcomeRecord, type CommandResultNote } from "@xmatrix/protocol";
import { publishChannelMessageCommandResult } from "./channel-live-judgment";
import { postgresMessageSystemAnnotation } from "./postgres-message-authority";
import type { Env } from "./types";

/** What one recording says: every statement's outcome, or one note. */
export type CommandResultEntry =
  | { controls: readonly AgentControlOutcomeRecord[] }
  | { note: Omit<CommandResultNote, "id" | "at"> };

export interface CommandResultDependencies {
  annotate?: typeof postgresMessageSystemAnnotation;
  publish?: typeof publishChannelMessageCommandResult;
}

/**
 * Record what a command came to on the message that wrote it, and tell the
 * Channel's people. The answer is not another message: it belongs to the
 * command, so it is drawn there and nowhere else, and it neither previews,
 * counts as unread, nor wakes anyone. `key` names the fact, so a replay of the
 * same command writes the same annotation once.
 */
export async function recordCommandResult(env: Env, input: {
  channelId: string; messageId: string; key: string; entry: CommandResultEntry;
}, dependencies: CommandResultDependencies = {}): Promise<void> {
  const annotationId = `${COMMAND_RESULT_ANNOTATION_NAMESPACE}:${input.messageId}:${input.key}`.slice(0, 200);
  const payload: Record<string, unknown> = "controls" in input.entry
    ? { controls: input.entry.controls }
    : { note: { ...input.entry.note, at: new Date().toISOString() } };
  const annotation = await (dependencies.annotate ?? postgresMessageSystemAnnotation)(env, {
    channelId: input.channelId, messageId: input.messageId,
    namespace: COMMAND_RESULT_ANNOTATION_NAMESPACE, annotationId, payload,
  });
  if (!annotation) return;
  await (dependencies.publish ?? publishChannelMessageCommandResult)(env, {
    channelId: input.channelId, messageId: input.messageId, annotationId, payload,
  });
}
