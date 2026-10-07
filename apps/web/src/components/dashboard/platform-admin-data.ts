"use client";

/**
 * Platform admin reads and the address state its views share.
 *
 * Every read here is metadata only and is recorded in the Hub's admin audit
 * trail; the Hub re-checks operator authority on each request.
 */

import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ADMIN_AUDIT_WEB_ROUTE,
  ADMIN_OVERVIEW_DEFAULT_ACTIVITY_DAYS,
  ADMIN_OVERVIEW_WEB_ROUTE,
  adminUserDetailWebRoute,
  type AdminAuditEvent,
  type AdminPlatformOverview,
  type AdminUserDetail,
} from "@xmatrix/protocol";

import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest, XMatrixApiError } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { parseAppLocation, pushBrowserPath, replaceBrowserPath } from "./workspace-shell-navigation";

const PARAM_EVENT = "xmatrix:admin-param";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(PARAM_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(PARAM_EVENT, onChange);
  };
}

/**
 * One search parameter of the admin address, so a filtered table or an open
 * user can be shared and Back undoes it. `push` makes the change a step Back
 * returns from; typing into a search replaces instead.
 */
export function useAdminParam(name: string): [string, (value: string, options?: { push?: boolean }) => void] {
  const read = useCallback(
    () => parseAppLocation(window.location.href).searchParams.get(name) ?? "",
    [name],
  );
  const value = useSyncExternalStore(subscribe, read, () => "");
  const set = useCallback((next: string, options: { push?: boolean } = {}) => {
    if (next === read()) return;
    const url = parseAppLocation(window.location.href);
    if (next) url.searchParams.set(name, next);
    else url.searchParams.delete(name);
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (options.push) pushBrowserPath(path);
    else replaceBrowserPath(path);
    window.dispatchEvent(new Event(PARAM_EVENT));
  }, [name, read]);
  return [value, set];
}

export function isForbidden(error: unknown): boolean {
  return error instanceof XMatrixApiError && error.status === 403;
}

export function usePlatformOverview(token: string | undefined, activityDays = ADMIN_OVERVIEW_DEFAULT_ACTIVITY_DAYS) {
  const { user } = useAuth();
  return useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "platform-overview", [activityDays]),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        activityDays: String(activityDays), spaceLimit: "200", userLimit: "10000",
      });
      return xmatrixApiRequest<{ overview?: AdminPlatformOverview }>({
        url: `${ADMIN_OVERVIEW_WEB_ROUTE}?${params}`, token, signal,
      }).then((payload) => payload.overview ?? null);
    },
    enabled: Boolean(token && user?.id),
    staleTime: 60_000,
  });
}

export function useAdminUserDetail(token: string | undefined, userId: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "platform-user", [userId]),
    queryFn: ({ signal }) => xmatrixApiRequest<{ detail?: AdminUserDetail }>({
      url: adminUserDetailWebRoute(userId), token, signal,
    }).then((payload) => payload.detail ?? null),
    enabled: Boolean(token && user?.id && userId),
    staleTime: 60_000,
  });
}

export function useAdminAudit(token: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "platform-audit", []),
    queryFn: ({ signal }) => xmatrixApiRequest<{ events?: AdminAuditEvent[] }>({
      url: `${ADMIN_AUDIT_WEB_ROUTE}?limit=500`, token, signal,
    }).then((payload) => payload.events ?? []),
    enabled: Boolean(token && user?.id),
  });
}
