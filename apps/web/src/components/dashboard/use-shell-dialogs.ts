"use client";

import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Search (Cmd/Ctrl+F, or the rail): one dialog. The shortcut searches where
 * the reader is, so inside a conversation it starts scoped to it; the rail
 * button searches the whole Space. Opening search on mobile focuses its input
 * in the same task so the on-screen keyboard comes up.
 */
export function useShellDialogs(isMobileViewport: boolean) {
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  /** Whether the open search starts scoped to where it was opened. */
  const [workspaceSearchHere, setWorkspaceSearchHere] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const hasCommandModifier = event.metaKey || event.ctrlKey;
      if (!hasCommandModifier || event.altKey || event.shiftKey || event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setWorkspaceSearchHere(true);
      setWorkspaceSearchOpen(true);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const openWorkspaceSearch = useCallback(() => {
    setWorkspaceSearchHere(false);

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
    workspaceSearchOpen,
    workspaceSearchHere,
    setWorkspaceSearchOpen,
    openWorkspaceSearch,
  };
}
