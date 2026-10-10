import type {
  ChannelMessage,
  ChannelMessageNotification,
  SerializedChannel,
  SerializedSpace,
} from "@xmatrix/protocol";
import type { DesktopBridge } from "@/lib/desktop/bridge";
import { channelAppPath, channelTitle, spaceAppPath } from "./channel-links";
import { isOwnChannelMessage } from "./workspace-shell-helpers-extra";
import {
  nativeMessageNotificationBody,
  nativeMessageNotificationTitle,
} from "./workspace-shell-recovered";

export function maybePushRecipientScopedNativeMessageNotification({
  entry,
  alreadyCached,
  notification,
  userId,
  notifiedMessageIds,
  bridge,
  channels,
  spaces,
  routeSpaceId,
  markNotified,
}: {
  entry: ChannelMessage;
  alreadyCached: boolean;
  notification: ChannelMessageNotification | undefined;
  userId: string;
  notifiedMessageIds: Set<string>;
  bridge: Pick<DesktopBridge, "notify"> | null;
  channels: SerializedChannel[];
  spaces: SerializedSpace[];
  routeSpaceId: string | null;
  markNotified: (messageId: string) => void;
}): void {
  if (alreadyCached || !notification || isOwnChannelMessage(entry, userId)) return;
  if (notifiedMessageIds.has(entry.messageId) || !bridge) return;
  if (!document.hidden && document.hasFocus()) return;

  const channel = channels.find((item) => item.id === entry.channelId);
  const url = channel
    ? channelAppPath(channel, spaces)
    : routeSpaceId
      ? spaceAppPath(routeSpaceId, spaces)
      : "/app";

  markNotified(entry.messageId);
  void bridge.notify({
    title: nativeMessageNotificationTitle(entry, channel && channelTitle(channel)),
    body: nativeMessageNotificationBody(entry),
    url,
    channelId: entry.channelId,
    metadata: entry.metadata,
  }).catch(() => undefined);
}
