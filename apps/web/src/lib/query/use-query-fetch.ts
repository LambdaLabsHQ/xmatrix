"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import {
  XMatrixRawResponseError,
  xmatrixQueryRawResponse,
  xmatrixRawResponse,
} from "./api-client";
import { xmatrixQueryKeys } from "./query-keys";

type RequestInput = string | URL | Request;

function requestUrl(input: RequestInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function linkedSignal(left: AbortSignal, right?: AbortSignal | null): AbortSignal {
  return right ? AbortSignal.any([left, right]) : left;
}

/**
 * Query-backed compatibility bridge for large event-handler surfaces.
 * GET/HEAD calls are coalesced by user and URL; commands run through a
 * no-retry mutation. Returned Responses are cloned so concurrent consumers
 * never share a body stream.
 */
export function useXMatrixQueryFetch(userId: string | null | undefined) {
  const queryClient = useQueryClient();
  const identity = useMemo(() => ({ userId: userId || "anonymous" }), [userId]);
  const command = useMutation({
    mutationKey: xmatrixQueryKeys.domain(identity, "http-command"),
    mutationFn: (input: { request: RequestInput; init?: RequestInit }) =>
      xmatrixRawResponse(input.request, input.init),
  });
  const mutateCommand = command.mutateAsync;

  return useCallback(async (request: RequestInput, init?: RequestInit): Promise<Response> => {
    const method = (init?.method || (request instanceof Request ? request.method : "GET"))
      .toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return mutateCommand({ request, init });
    }
    try {
      const response = await queryClient.fetchQuery({
        queryKey: xmatrixQueryKeys.domain(identity, "http-query", [method, requestUrl(request)]),
        queryFn: ({ signal }) => xmatrixQueryRawResponse(request, {
          ...init,
          signal: linkedSignal(signal, init?.signal),
        }),
        staleTime: 0,
      });
      return response.clone();
    } catch (error) {
      if (error instanceof XMatrixRawResponseError) return error.response.clone();
      throw error;
    }
  }, [identity, mutateCommand, queryClient]);
}
