import type { MutableRefObject } from "react";

import { INITIAL_HISTORY_LIMIT } from "./workspace-shell-constants";

export type HumanChannelFocusRequest = {
  socket: WebSocket;
  channelId: string | null;
  sentAt: number;
};

type SendHumanChannelFocusInput = {
  channelId: string | null;
  socket: WebSocket | null | undefined;
  connected: boolean;
  selectedChannelIdRef: MutableRefObject<string | null>;
  historyChannelIdRef: MutableRefObject<string | null>;
  lastHumanFocusRequestRef: MutableRefObject<HumanChannelFocusRequest | null>;
};

/**
 * The live socket focus send is the only place a first history page can be
 * requested. Stamp the accept refs in the same synchronous turn, before
 * send(), so a channel_history that arrives before React commits the route
 * is never judged as belonging to the previous channel.
 */
export function sendHumanChannelFocus(input: SendHumanChannelFocusInput): boolean {
  const socket = input.socket;
  if (!input.connected || !socket || socket.readyState !== WebSocket.OPEN) return false;
  if (input.channelId) {
    input.selectedChannelIdRef.current = input.channelId;
    input.historyChannelIdRef.current = input.channelId;
  }
  input.lastHumanFocusRequestRef.current = {
    socket,
    channelId: input.channelId,
    sentAt: performance.now(),
  };
  socket.send(JSON.stringify({
    type: "user_focus_channel",
    requestId: input.channelId ? `focus-history:${input.channelId}` : undefined,
    channelId: input.channelId,
    historyLimit: input.channelId ? INITIAL_HISTORY_LIMIT : undefined,
  }));
  return true;
}
