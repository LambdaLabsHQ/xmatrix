"use client";

import { QueryCache, QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { useEffect, useMemo, type ReactNode } from "react";

import { subscribeResume } from "@/lib/connectivity/connectivity";
import { shouldRetryXMatrixQuery } from "./api-client";

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

export function XMatrixQueryProvider(props: { userId: string | null; children: ReactNode }) {
  const client = useMemo(createClient, [props.userId]);

  useEffect(() => {
    return () => client.clear();
  }, [client]);

  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>;
}
