"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import {
  XMatrixRawResponseError,
  xmatrixQueryRawResponse,
  xmatrixRawResponse,
} from "./api-client";
import { untilCallerAborts } from "./caller-abort";
import { xmatrixQueryKeys } from "./query-keys";

type RequestInput = string | URL | Request;

function requestUrl(input: RequestInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
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
    const { signal: callerSignal, ...sharedInit } = init ?? {};
    try {
      const response = await untilCallerAborts(queryClient.fetchQuery({
        queryKey: xmatrixQueryKeys.domain(identity, "http-query", [method, requestUrl(request)]),
        queryFn: ({ signal }) => xmatrixQueryRawResponse(request, { ...sharedInit, signal }),
        staleTime: 0,
      }), callerSignal);
      return response.clone();
    } catch (error) {
      if (error instanceof XMatrixRawResponseError) return error.response.clone();
      throw error;
    }
  }, [identity, mutateCommand, queryClient]);
}
