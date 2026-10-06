"use client";

import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * The channel quick-open (Cmd/Ctrl+P) and workspace search (Cmd/Ctrl+F)
 * dialogs: at most one is open, and opening search on mobile focuses its input
 * in the same task so the on-screen keyboard comes up.
 */
export function useShellDialogs(isMobileViewport: boolean) {
  const [channelQuickOpen, setChannelQuickOpen] = useState(false);

  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const hasCommandModifier = event.metaKey || event.ctrlKey;
      if (!hasCommandModifier || event.altKey || event.shiftKey || event.defaultPrevented) return;

      const key = event.key.toLowerCase();
      if (key === "p") {
        event.preventDefault();
        setWorkspaceSearchOpen(false);
        setChannelQuickOpen(true);
      } else if (key === "f") {
        event.preventDefault();
        setChannelQuickOpen(false);
        setWorkspaceSearchOpen(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const openWorkspaceSearch = useCallback(() => {
    setChannelQuickOpen(false);

    if (!isMobileViewport || typeof document === "undefined") {
      setWorkspaceSearchOpen(true);
      return;
    }

    flushSync(() => {
      setWorkspaceSearchOpen(true);
    });
    document.querySelector<HTMLInputElement>("[data-workspace-search-input='mobile']")?.focus();
  }, [isMobileViewport]);

  return {
    channelQuickOpen,
    setChannelQuickOpen,
    workspaceSearchOpen,
    setWorkspaceSearchOpen,
    openWorkspaceSearch,
  };
}
