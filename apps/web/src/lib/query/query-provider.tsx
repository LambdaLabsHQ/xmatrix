"use client";

import { QueryCache, QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { subscribeResume } from "@/lib/connectivity/connectivity";
import { shouldRetryXMatrixQuery, xmatrixRetryDelayMs } from "./api-client";

function createClient(): QueryClient {
  return new QueryClient({
    // React Query names a query that resolved to undefined only in development.
    // Name it in every build: a response did not have the shape its reader
    // expects. The e2e page fixture fails on this line.
    queryCache: new QueryCache({
      onError: (error) => {
        if (error.message.endsWith(" data is undefined")) console.error(`xMatrix query resolved to undefined: ${error.message}`);
      },
    }),
    defaultOptions: {
      queries: {
        retry: shouldRetryXMatrixQuery,
        retryDelay: xmatrixRetryDelayMs,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        gcTime: 10 * 60 * 1_000,
      },
      mutations: { retry: false },
    },
  });
}

// Query's reconnect refetch follows the same signal as every socket and sync
// loop (src/lib/connectivity), not a listener set of its own.
onlineManager.setEventListener((setOnline) => {
  if (typeof window === "undefined") return undefined;
  const offline = () => setOnline(false);
  window.addEventListener("offline", offline);
  const stopResume = subscribeResume((signal) => {
    if (signal.online) setOnline(true);
  });
  return () => {
    window.removeEventListener("offline", offline);
    stopResume();
  };
});

/**
 * Key of the query tree. Observers keep the client that created them, so a
 * change from one signed-in account to another, or a sign-out, remounts them
 * onto the cache their actions write. The first sign-in does not: the open
 * page has already read a one-time callback or stored where to return.
 */
export function queryMountKey(
  mountKey: string | undefined,
  previousUserId: string | null | undefined,
  userId: string | null,
): string {
  if (previousUserId === undefined || mountKey === undefined) return userId ?? "anonymous";
  if (previousUserId && previousUserId !== userId) return userId ?? "anonymous";
  return mountKey;
}

export function XMatrixQueryProvider(props: { userId: string | null; children: ReactNode }) {
  const client = useMemo(createClient, [props.userId]);
  const mountKeyRef = useRef<string | undefined>(undefined);
  const previousUserIdRef = useRef<string | null | undefined>(undefined);
  const mountKey = queryMountKey(mountKeyRef.current, previousUserIdRef.current, props.userId);
  mountKeyRef.current = mountKey;
  previousUserIdRef.current = props.userId;

  useEffect(() => {
    return () => client.clear();
  }, [client]);

  return <QueryClientProvider key={mountKey} client={client}>{props.children}</QueryClientProvider>;
}
