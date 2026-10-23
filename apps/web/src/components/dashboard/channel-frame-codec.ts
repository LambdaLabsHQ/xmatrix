import { decodeChannelSnapshot, type ChannelSnapshot, type SerializedChannel } from "@xmatrix/protocol";
import type { HumanServerMessage } from "@xmatrix/protocol/connections/human";

type SnapshotFrame<M> = M extends { channel: SerializedChannel }
  ? Omit<M, "channel"> & { channel: ChannelSnapshot }
  : M extends { channels: SerializedChannel[] }
    ? Omit<M, "channels"> & { channels: ChannelSnapshot[] } : M;
export type ChannelSnapshotFrame = SnapshotFrame<HumanServerMessage>;

/** Wire compatibility is consumed before frames enter the realtime batch/store. */
export function decodeChannelFrame(message: HumanServerMessage): ChannelSnapshotFrame {
  if ("channel" in message) return { ...message, channel: decodeChannelSnapshot(message.channel) } as ChannelSnapshotFrame;
  if ("channels" in message) return { ...message, channels: message.channels.map(decodeChannelSnapshot) } as ChannelSnapshotFrame;
  return message;
}
