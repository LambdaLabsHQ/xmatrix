"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, type ReactNode } from "react";

import { shouldRetryXMatrixQuery } from "./api-client";

function createClient(): QueryClient {
  return new QueryClient({
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

export function XMatrixQueryProvider(props: { userId: string | null; children: ReactNode }) {
  const client = useMemo(createClient, [props.userId]);

  useEffect(() => {
    return () => client.clear();
  }, [client]);

  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>;
}
