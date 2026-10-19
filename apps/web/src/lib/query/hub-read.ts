"use client";

import { clientCompatibilityHeaders } from "@xmatrix/protocol";
import { requireAcceptedAppCompatibilityIdentity } from "@/lib/app-client-compatibility";
import { siteUrl } from "@/lib/site-url";
import { requireJson, xmatrixHubOrigin, xmatrixRawResponse } from "./api-client";

/**
 * Whether this page reads from the Hub straight, as it already opens live page sessions and signs in: it runs
 * at the app's own origin, the one the Hub answers (packages/hub/src/direct-read-cors.ts). An app shell at any
 * other origin, or a build that turns it off, reads through the Web as before.
 */
function readsFromHub(): boolean {
  if (process.env.NEXT_PUBLIC_XMATRIX_DIRECT_HUB_READS === "0" || typeof window === "undefined") return false;
  return window.location.origin === siteUrl.origin;
}

function admittedIdentity() {
  try {
    return requireAcceptedAppCompatibilityIdentity();
  } catch {
    return null;
  }
}

/**
 * A read the Hub answers straight to this page, skipping the Web's Worker. The Web answers it when the Hub will
 * not from here: no admitted client identity yet, no answer across origins, a token the Hub no longer takes
 * (the Web renews it from the session), or a client identity it refuses (the Web carries the admitted one).
 * Either way the Hub authorizes the same bearer on the same route.
 */
export async function hubReadResponse(input: { hubPath: string; webUrl: string; token: string;
  signal?: AbortSignal }): Promise<Response> {
  const identity = readsFromHub() && input.token ? admittedIdentity() : null;
  if (identity) {
    try {
      const response = await xmatrixRawResponse(`${xmatrixHubOrigin()}${input.hubPath}`, {
        headers: { Authorization: `Bearer ${input.token}`, ...clientCompatibilityHeaders(identity) },
        credentials: "omit",
        signal: input.signal,
      });
      if (response.status !== 401 && response.status !== 426) return response;
    } catch (cause) {
      if (input.signal?.aborted) throw cause;
    }
  }
  return xmatrixRawResponse(input.webUrl, {
    headers: input.token ? { Authorization: `Bearer ${input.token}` } : {},
    signal: input.signal,
  });
}

/** A read's JSON, from the Hub straight when it answers this page (`hubReadResponse`). */
export async function xmatrixHubRead<T>(input: { hubPath: string; webUrl: string; token: string;
  signal?: AbortSignal }): Promise<T> {
  return requireJson<T>(await hubReadResponse(input), input.signal);
}
