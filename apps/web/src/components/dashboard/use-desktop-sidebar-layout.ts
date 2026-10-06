"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  DESKTOP_SIDEBAR_DEFAULT_WIDTH_PX,
  DESKTOP_SIDEBAR_MAX_WIDTH_PX,
  DESKTOP_SIDEBAR_MIN_WIDTH_PX,
  DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./workspace-shell-constants";
import { clampDesktopSidebarWidth, readStoredDesktopSidebarWidth } from "./workspace-shell-helpers";

/** The desktop channel sidebar's width: stored per device, dragged or keyed. */
export function useDesktopSidebarLayout() {
  const [desktopSidebarWidth, setDesktopSidebarWidth] = useState(DESKTOP_SIDEBAR_DEFAULT_WIDTH_PX);

  const [resizingDesktopSidebar, setResizingDesktopSidebar] = useState(false);

  const desktopSidebarResizeRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);

  useEffect(() => {
    setDesktopSidebarWidth(readStoredDesktopSidebarWidth());
  }, []);

  const updateDesktopSidebarWidth = useCallback((value: number | ((current: number) => number)) => {
    setDesktopSidebarWidth((current) => {
      const next = clampDesktopSidebarWidth(typeof value === "function" ? value(current) : value);
      window.localStorage.setItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    if (!resizingDesktopSidebar) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(event: PointerEvent) {
      const resize = desktopSidebarResizeRef.current;
      if (!resize) return;
      updateDesktopSidebarWidth(resize.startWidth + event.clientX - resize.startX);
    }

    function stopResize() {
      desktopSidebarResizeRef.current = null;
      setResizingDesktopSidebar(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [resizingDesktopSidebar, updateDesktopSidebarWidth]);

  function startDesktopSidebarResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (window.innerWidth < 768) return;
    event.preventDefault();
    desktopSidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: desktopSidebarWidth,
    };
    setResizingDesktopSidebar(true);
  }

  function handleDesktopSidebarResizeKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      updateDesktopSidebarWidth((current) => current + (event.key === "ArrowRight" ? 16 : -16));
    } else if (event.key === "Home") {
      event.preventDefault();
      updateDesktopSidebarWidth(DESKTOP_SIDEBAR_MIN_WIDTH_PX);
    } else if (event.key === "End") {
      event.preventDefault();
      updateDesktopSidebarWidth(DESKTOP_SIDEBAR_MAX_WIDTH_PX);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      updateDesktopSidebarWidth(DESKTOP_SIDEBAR_DEFAULT_WIDTH_PX);
    }
  }

  return {
    desktopSidebarWidth,
    resizingDesktopSidebar,
    startDesktopSidebarResize,
    handleDesktopSidebarResizeKey,
  };
}
