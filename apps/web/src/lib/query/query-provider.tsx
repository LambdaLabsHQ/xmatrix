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
 * One key for the mounted page and its query client. First sign-in binds the
 * current anonymous tree; leaving a signed-in account starts a fresh one,
 * even if that account had kept the initial anonymous key.
 */
export function queryMountKey(
  mountKey: number | undefined,
  previousUserId: string | null | undefined,
  userId: string | null,
): number {
  const current = mountKey ?? 0;
  return previousUserId != null && previousUserId !== userId ? current + 1 : current;
}

export function XMatrixQueryProvider(props: { userId: string | null; children: ReactNode }) {
  const mountKeyRef = useRef<number | undefined>(undefined);
  const previousUserIdRef = useRef<string | null | undefined>(undefined);
  const mountKey = queryMountKey(mountKeyRef.current, previousUserIdRef.current, props.userId);
  mountKeyRef.current = mountKey;
  previousUserIdRef.current = props.userId;
  // An observer retains its creating client. Keep both lifetimes together.
  const client = useMemo(createClient, [mountKey]);

  useEffect(() => {
    return () => client.clear();
  }, [client]);

  return <QueryClientProvider key={mountKey} client={client}>{props.children}</QueryClientProvider>;
}
