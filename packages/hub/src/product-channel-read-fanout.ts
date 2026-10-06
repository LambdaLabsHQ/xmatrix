/**
 * Live fanout for Human read cursors.
 *
 * A member's read cursor is what mention read state at the `@` is derived
 * from, so an advancing cursor has to reach the other members while they are
 * looking at the message. Channel payloads already carry `memberReadSequences`
 * on catalog and single-channel reads; this closes the live gap without
 * re-serializing the whole Channel on every acknowledgement.
 *
 * Best effort by construction: the durable cursor is already committed when
 * this runs, and the next Channel read repairs anything a dropped frame lost.
 */
import type { ObservabilityEvent } from "@xmatrix/protocol";

import type { HumanFanoutChannelReader } from "./runtime-transport/human-presence-fanout";

export const CHANNEL_MEMBER_READ_EVENT_TYPE = "channel_member_read_updated";

export interface ChannelMemberReadFanoutInput {
  readChannel: HumanFanoutChannelReader;
  runtime: { fetch(request: Request): Promise<Response> };
  channelId: string;
  /** Durable subject identity of the reader (`user:<userId>`). */
  subjectId: string;
  readSequence: number;
  /** The reader already knows its own cursor; the frame is for the others. */
  actorUserId: string;
  /** Remaining attention after the acknowledgement; omitted when clear created a tombstone. */
  attention?: import("@xmatrix/protocol").ChannelAttentionSummary;
}

export function channelAttentionUpdatedEvent(
  input: Pick<ChannelMemberReadFanoutInput, "actorUserId" | "attention" | "channelId" | "readSequence">,
): ObservabilityEvent {
  return {
    id: crypto.randomUUID(),
    type: "channel_attention_updated",
    workspaceUserId: input.actorUserId,
    channelId: input.channelId,
    metadata: {
      readSequence: input.readSequence,
      ...(input.attention ? { attention: input.attention } : {}),
    },
    timestamp: new Date().toISOString(),
  } as ObservabilityEvent;
}

export function channelMemberReadEvent(
  input: Pick<
    ChannelMemberReadFanoutInput,
    "channelId" | "subjectId" | "readSequence" | "actorUserId"
  >,
): ObservabilityEvent {
  return {
    id: crypto.randomUUID(),
    type: CHANNEL_MEMBER_READ_EVENT_TYPE,
    workspaceUserId: input.actorUserId,
    channelId: input.channelId,
    metadata: {
      subjectId: input.subjectId,
      readSequence: input.readSequence,
    },
    timestamp: new Date().toISOString(),
  } as ObservabilityEvent;
}
