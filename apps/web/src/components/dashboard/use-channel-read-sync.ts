import { useQueryClient } from "@tanstack/react-query";
import type { SerializedChannel } from "@xmatrix/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { applyChannelReadStateToCatalog } from "./channel-catalog-read-state";
import { ChannelReadSyncCoordinator } from "./channel-read-sync";
import {
  syncChannelReadCursor,
  updateChannelReadState,
  type ChannelReadStateUpdate,
} from "./workspace-admin-views";
import type { AppView } from "./workspace-shell-navigation";

type ReadCountsUpdater = (
  updater: (current: Record<string, number>) => Record<string, number>,
) => void;

type UseChannelReadSyncOptions = {
  accessTokenRef: MutableRefObject<string | undefined>;
  userId: string | undefined;
  channelsRef: MutableRefObject<SerializedChannel[]>;
  selectedChannelIdRef: MutableRefObject<string | null>;
  timelineActiveRef: MutableRefObject<boolean>;
  viewRef: MutableRefObject<AppView>;
  setChannels: Dispatch<SetStateAction<SerializedChannel[]>>;
  updateChannelReadCounts: ReadCountsUpdater;
};

export function useChannelReadSync({
  accessTokenRef,
  userId,
  channelsRef,
  selectedChannelIdRef,
  timelineActiveRef,
  viewRef,
  setChannels,
  updateChannelReadCounts,
}: UseChannelReadSyncOptions) {
  const lastSyncedReadSequenceRef = useRef<Record<string, number>>({});
  const coordinatorRef = useRef<ChannelReadSyncCoordinator<ChannelReadStateUpdate> | null>(null);
  const queryClient = useQueryClient();
  // The coordinator is built once, so the acknowledgement handler reads the
  // current viewer through a ref rather than closing over the first one.
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const applyReadState = useCallback((channelId: string, readState: ChannelReadStateUpdate) => {
    const readSequence = Math.max(
      lastSyncedReadSequenceRef.current[channelId] || 0,
      readState.readSequence || 0,
    );
    lastSyncedReadSequenceRef.current[channelId] = readSequence;
    setChannels((current) => updateChannelReadState(current, channelId, {
      ...readState,
      readSequence,
    }));
    // The sidebar badge is rendered from the paged catalog, which no
    // realtime read update reaches. Without this the channel stays lit
    // after it has been read, until the catalog happens to refetch.
    const currentUserId = userIdRef.current;
    if (currentUserId) {
      applyChannelReadStateToCatalog({
        client: queryClient,
        prefix: xmatrixQueryKeys.all({ userId: currentUserId }),
        readStates: new Map([[channelId, { ...readState, readSequence }]]),
      });
    }
  }, [queryClient, setChannels]);
  const applyReadStateRef = useRef(applyReadState);
  applyReadStateRef.current = applyReadState;

  if (!coordinatorRef.current) {
    coordinatorRef.current = new ChannelReadSyncCoordinator({
      send: (channelId, sequence) => {
        const accessToken = accessTokenRef.current;
        return accessToken
          ? syncChannelReadCursor(accessToken, channelId, sequence)
          : Promise.resolve(undefined);
      },
      onSuccess: (channelId, readState) => applyReadStateRef.current(channelId, readState),
    });
  }

  /** The reader is done with what waits on them in a conversation: read to its head, mentions answered. */
  const markChannelResponded = useCallback(async (channelId: string) => {
    const accessToken = accessTokenRef.current;
    const channel = channelsRef.current.find((candidate) => candidate.id === channelId);
    const sequence = Math.max(channel?.historyHeadSequence ?? 0, channel?.messageCount ?? 0,
      channel?.attention?.lastMessageSequence ?? 0);
    if (!accessToken || sequence <= 0) return;
    const readState = await syncChannelReadCursor(accessToken, channelId, sequence, true);
    // The Hub omits a cleared attention summary, and that absence is the answer.
    if (readState) applyReadState(channelId, { attention: readState.attention, readSequence: readState.readSequence });
    updateChannelReadCounts((current) => (current[channelId] || 0) >= sequence
      ? current : { ...current, [channelId]: sequence });
  }, [accessTokenRef, applyReadState, channelsRef, updateChannelReadCounts]);

  useEffect(() => () => coordinatorRef.current?.reset(), []);

  const markChannelReadToSequence = useCallback((
    channelId: string,
    sequence: number | undefined,
  ) => {
    if (sequence === undefined || !Number.isFinite(sequence) || sequence <= 0) return;
    if (
      selectedChannelIdRef.current !== channelId ||
      viewRef.current !== "messages" ||
      !timelineActiveRef.current ||
      document.hidden ||
      !document.hasFocus()
    ) return;

    const accessToken = accessTokenRef.current;
    const channelAttentionUnread = channelsRef.current.find((channel) => channel.id === channelId)
      ?.attention?.unreadAttentionCount || 0;
    if (accessToken) {
      coordinatorRef.current!.observe(channelId, lastSyncedReadSequenceRef.current[channelId]);
      coordinatorRef.current!.enqueue(channelId, sequence, {
        attentionUnread: channelAttentionUnread > 0,
      });
    }

    updateChannelReadCounts((current) => {
      if ((current[channelId] || 0) >= sequence) return current;
      return { ...current, [channelId]: sequence };
    });
  }, [
    accessTokenRef,
    channelsRef,
    selectedChannelIdRef,
    timelineActiveRef,
    updateChannelReadCounts,
    viewRef,
  ]);

  const observeChannelReadSequence = useCallback((channelId: string, sequence: number) => {
    lastSyncedReadSequenceRef.current[channelId] = sequence;
    coordinatorRef.current?.observe(channelId, sequence);
  }, []);

  const resetChannelReadSync = useCallback(() => {
    coordinatorRef.current?.reset();
    lastSyncedReadSequenceRef.current = {};
  }, []);

  return {
    markChannelResponded,
    markChannelReadToSequence,
    observeChannelReadSequence,
    resetChannelReadSync,
  };
}
