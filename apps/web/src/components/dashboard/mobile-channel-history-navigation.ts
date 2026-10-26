import type { MutableRefObject } from "react";
import type { ChannelSnapshot, SerializedSpace } from "@xmatrix/protocol";
import { spaceAppPath } from "./channel-links";
import {
  MOBILE_CHANNEL_DETAILS_HASH,
  clearBrowserHash,
  currentBrowserLocation,
  isMobileChannelDetailsLocation,
  pushBrowserPath,
  replaceBrowserPath,
} from "./workspace-shell-navigation";

/*
 * A phone's conversation screens go Back to their parent: channel details to
 * the conversation, a conversation to its Space's channel list. Neither reads
 * the browser history, so however the screen was reached (a list tap, a
 * notification, a new conversation, a thread) Back lands in the same place.
 */
export function createMobileChannelHistoryNavigation(options: {
  mobileChannelDetailsOpen: boolean;
  setMobileChannelDetailsOpen: (open: boolean) => void;
  selectedChannel: ChannelSnapshot | null;
  selectedChannelIdRef: MutableRefObject<string | null>;
  currentSpaceId: string | null;
  spaces: SerializedSpace[];
  setSelectedChannelId: (id: string | null) => void;
  setReplyTarget: (target: null) => void;
  setBrowserPath: (path: string) => void;
  setBrowserHash: (hash: string) => void;
  runMobileScreenTransition: (direction: "forward" | "back", update: () => void) => void;
}) {
  const {
    mobileChannelDetailsOpen,
    setMobileChannelDetailsOpen,
    selectedChannel,
    selectedChannelIdRef,
    currentSpaceId,
    spaces,
    setSelectedChannelId,
    setReplyTarget,
    setBrowserPath,
    setBrowserHash,
    runMobileScreenTransition,
  } = options;

  function openMobileChannelDetails() {
    if (mobileChannelDetailsOpen) return;
    setMobileChannelDetailsOpen(true);
    setBrowserHash(MOBILE_CHANNEL_DETAILS_HASH);
    // The entry keeps Next.js's router state, so the router stays on the Channel.
    if (!isMobileChannelDetailsLocation()) pushBrowserPath(`${currentBrowserLocation()}${MOBILE_CHANNEL_DETAILS_HASH}`, {});
  }

  function closeMobileChannelDetails() {
    setMobileChannelDetailsOpen(false);
    setBrowserHash("");
    clearBrowserHash();
  }

  /* Clearing the selection drops the messages view into its mobile list state. */
  function backToChannelList() {
    const spaceId = selectedChannel?.spaceId || currentSpaceId;
    const nextPath = spaceId ? `${spaceAppPath(spaceId, spaces)}/channels` : "/app";
    runMobileScreenTransition("back", () => {
      setSelectedChannelId(null);
      selectedChannelIdRef.current = null;
      setMobileChannelDetailsOpen(false);
      setReplyTarget(null);
      replaceBrowserPath(nextPath);
      setBrowserPath(nextPath);
      setBrowserHash("");
    });
  }

  return {
    openMobileChannelDetails,
    closeMobileChannelDetails,
    backToChannelList,
  };
}
