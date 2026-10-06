import type { MutableRefObject } from "react";
import type { SerializedChannel, SerializedSpace } from "@xmatrix/protocol";
import { spaceAppPath } from "./channel-links";
import {
  MOBILE_CHANNEL_DETAILS_HASH,
  MOBILE_CHANNEL_DETAILS_RETURN_PATH_STATE_KEY,
  MOBILE_CHANNEL_LIST_RETURN_PATH_STATE_KEY,
  currentBrowserLocation,
  isMobileChannelDetailsHistoryState,
  isMobileChannelDetailsLocation,
  pushBrowserHistoryState,
  pushBrowserPath,
  replaceBrowserPath,
} from "./workspace-shell-navigation";

export function createMobileChannelHistoryNavigation(options: {
  mobileChannelDetailsOpen: boolean;
  setMobileChannelDetailsOpen: (open: boolean) => void;
  selectedChannel: SerializedChannel | null;
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
    const currentPath = currentBrowserLocation();
    setMobileChannelDetailsOpen(true);
    setBrowserHash(MOBILE_CHANNEL_DETAILS_HASH);
    if (
      !isMobileChannelDetailsLocation() &&
      !isMobileChannelDetailsHistoryState(window.history.state, currentPath)
    ) {
      pushBrowserHistoryState(
        { [MOBILE_CHANNEL_DETAILS_RETURN_PATH_STATE_KEY]: currentPath },
        `${currentPath}${MOBILE_CHANNEL_DETAILS_HASH}`
      );
    }
  }

  function closeMobileChannelDetails() {
    setMobileChannelDetailsOpen(false);
    if (
      isMobileChannelDetailsLocation() ||
      isMobileChannelDetailsHistoryState(window.history.state, currentBrowserLocation())
    ) {
      window.history.back();
    }
  }

  /* Clearing the selection drops the messages view into its mobile list state. */
  function showMobileChannelList(useExistingHistoryEntry = false) {
    const spaceId = selectedChannel?.spaceId || currentSpaceId;
    const nextPath = spaceId ? `${spaceAppPath(spaceId, spaces)}/channels` : "/app";
    const historyState = window.history.state;
    const currentPath = currentBrowserLocation();
    const detailsHistoryOpen =
      isMobileChannelDetailsLocation() ||
      isMobileChannelDetailsHistoryState(historyState, currentPath);
    const canReuseListEntry =
      useExistingHistoryEntry &&
      historyState?.[MOBILE_CHANNEL_LIST_RETURN_PATH_STATE_KEY] === nextPath;
    runMobileScreenTransition("back", () => {
      setSelectedChannelId(null);
      selectedChannelIdRef.current = null;
      setMobileChannelDetailsOpen(false);
      setReplyTarget(null);
      // A channel opened from this list already has the list immediately behind
      // it. Reuse that entry so the Back button cannot add list/detail cycles.
      // Summary / channel-info adds one more same-URL entry on top, so list
      // return has to skip that overlay too.
      if (canReuseListEntry && detailsHistoryOpen) {
        window.history.go(-2);
      } else if (canReuseListEntry) {
        window.history.back();
      } else if (useExistingHistoryEntry) {
        replaceBrowserPath(nextPath);
      } else {
        pushBrowserPath(nextPath);
      }
      setBrowserPath(nextPath);
      setBrowserHash("");
    });
  }

  function backToChannelList() {
    showMobileChannelList(true);
  }

  return {
    openMobileChannelDetails,
    closeMobileChannelDetails,
    showMobileChannelList,
    backToChannelList,
  };
}
