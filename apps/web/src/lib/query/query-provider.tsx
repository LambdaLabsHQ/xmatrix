"use client";

import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, type ReactNode } from "react";

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

export function XMatrixQueryProvider(props: { userId: string | null; children: ReactNode }) {
  const client = useMemo(createClient, [props.userId]);

  useEffect(() => {
    return () => client.clear();
  }, [client]);

  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>;
}
