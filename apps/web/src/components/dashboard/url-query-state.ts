"use client";

import { useCallback, useSyncExternalStore } from "react";
import { appRouteInfo, pushBrowserPath, replaceBrowserPath, viewSelectionParameter } from "./workspace-shell-navigation";

const QUERY_EVENT = "xmatrix:url-query";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(QUERY_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(QUERY_EVENT, onChange);
  };
}

function writeParameter(parameter: string, next: string | null, options: { replace?: boolean } = {}) {
  const url = new URL(window.location.href);
  const current = url.searchParams.get(parameter)?.trim() || null;
  // Old anonymous selection is retired; it is never a fallback or alias.
  url.searchParams.delete("item");
  if (next) url.searchParams.set(parameter, next);
  else url.searchParams.delete(parameter);
  if (url.href === window.location.href) return;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Switching replaces; opening from a list is a step Back returns from.
  if (options.replace || current) replaceBrowserPath(path);
  else pushBrowserPath(path);
  window.dispatchEvent(new Event(QUERY_EVENT));
}

/** Read and write one explicitly named URL field without a second local state. */
export function useUrlParameter(parameter: string): [string | null, (next: string | null, options?: { replace?: boolean }) => void] {
  const read = useCallback(() => new URL(window.location.href).searchParams.get(parameter)?.trim() || null, [parameter]);
  const write = useCallback((next: string | null, options?: { replace?: boolean }) => writeParameter(parameter, next, options), [parameter]);
  return [useSyncExternalStore(subscribe, read, () => null), write];
}

/** The phone's shell Back closes the domain selection owned by this destination. */
export function closeViewSelection(): boolean {
  const parameter = viewSelectionParameter(appRouteInfo(window.location.href).view);
  if (!parameter || !new URL(window.location.href).searchParams.get(parameter)) return false;
  writeParameter(parameter, null);
  return true;
}
