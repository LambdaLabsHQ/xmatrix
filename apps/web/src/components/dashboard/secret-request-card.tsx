"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Loader2 } from "lucide-react";
import { parseSecretRequestCard, WEB_PROXY_ROUTES, type SecretRequestCard } from "@xmatrix/protocol";

import { actionClass } from "@/components/ui/action-tone";
import { statusChipClass } from "@/components/ui/status-tone";
import { ErrorNotice } from "@/components/ui/error-notice";
import { errorFromResponse } from "@/lib/query/api-client";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { userErrorMessage } from "@/lib/user-facing-error";

/**
 * A card an Agent posts when it needs a Space secret it may not read yet. A
 * Space admin lets it use one the Space holds, or types the value of a new
 * one; the value goes from this browser to the Space's secrets under the
 * admin's session, and the Agent may read it at once.
 */
export function secretRequestMetadata(metadata: Record<string, unknown> | undefined): SecretRequestCard | null {
  return parseSecretRequestCard(metadata?.secretRequest);
}

interface SecretRequestStatus {
  saved: boolean;
  readable: boolean;
  canApprove: boolean;
  envName?: string;
}

function requestStatus(payload: Record<string, unknown>): SecretRequestStatus {
  const secret = payload.secret as { envName?: unknown } | undefined;
  return { saved: payload.saved === true, readable: payload.readable === true, canApprove: payload.canApprove === true,
    ...(typeof secret?.envName === "string" ? { envName: secret.envName } : {}) };
}

function statusQueryKey(userId: string, request: SecretRequestCard) {
  return ["secret-request-status", userId, request.runId, request.secretRef];
}

export function SecretRequestCardView({ request, token, userId }: {
  request: SecretRequestCard;
  token?: string | null;
  userId: string;
}) {
  const fetch = useXMatrixQueryFetch(userId);
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryKey = statusQueryKey(userId, request);
  const statusQuery = useQuery<SecretRequestStatus>({
    queryKey,
    enabled: Boolean(token),
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(WEB_PROXY_ROUTES.secret_request_status, {
        method: "POST", signal, cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ runId: request.runId, channelId: request.channelId, secretRef: request.secretRef }),
      });
      if (!response.ok) throw await errorFromResponse(response);
      return requestStatus(await response.json());
    },
  });
  const status = statusQuery.data;
  const done = Boolean(status?.readable);
  const canApprove = status?.canApprove === true;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(WEB_PROXY_ROUTES.secret_request_fulfill, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, ...(value.trim() ? { value } : {}) }),
      });
      if (!response.ok) throw await errorFromResponse(response);
      const payload = await response.json();
      setValue("");
      queryClient.setQueryData(queryKey, requestStatus(payload));
    } catch (saveError) {
      setError(userErrorMessage(saveError, "Couldn't save the secret"));
    } finally {
      setBusy(false);
    }
  }

  const inputId = `secret-request-${request.runId}-${request.secretRef}`;
  const needsValue = !status?.saved;
  return (
    <div className="app-request-broker-card mt-2 w-full max-w-2xl rounded-md border border-border bg-muted/35 p-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="app-request-broker-icon mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-sm font-black">Secret for {request.agentName || "an Agent"}</span>
            {status && (
              <span className={statusChipClass(done ? "settled" : "attention",
                "app-request-broker-status px-1.5 py-0.5 text-[11px] font-bold")}>
                {done ? "In use" : !canApprove ? "A Space admin answers" : status.saved ? "Waiting for your approval"
                  : "Waiting for the value"}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono text-foreground">{request.secretRef}</span>
            {(status?.envName ?? request.envName) && <>
              <span>as</span>
              <span className="font-mono text-foreground">{status?.envName ?? request.envName}</span>
            </>}
          </div>
          {(request.description || request.reason) && (
            <div className="mt-1 text-xs text-muted-foreground">{request.reason || request.description}</div>
          )}
          {status && !done && !canApprove && (
            <p className="mt-2 text-xs text-muted-foreground">Only a Space admin can answer this.</p>
          )}
          {statusQuery.isLoading && <Loader2 className="mt-2 size-3.5 animate-spin text-muted-foreground" />}
          {error ? <div role="alert" className="mt-2 text-xs text-destructive">{error}</div>
            : <ErrorNotice error={statusQuery.error} action="Couldn't load this secret request"
              className="mt-2 text-xs text-destructive" onRetry={() => void statusQuery.refetch()} />}
          {status && !done && canApprove && (
            <form
              className="mt-3 space-y-2"
              onSubmit={(event) => { event.preventDefault(); void save(); }}
            >
              <label htmlFor={inputId} className="block space-y-1 text-xs">
                <span className="font-bold text-foreground">{needsValue ? "Value" : "New value (optional)"}</span>
                <input
                  id={inputId}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={value}
                  disabled={busy}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={needsValue ? "Paste the value here" : "Leave empty to keep the stored value"}
                  className="app-request-broker-control h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground"
                  aria-label={`Value for secret ${request.secretRef}`}
                />
              </label>
              <button
                type="submit"
                disabled={busy || (needsValue && !value.trim())}
                className={actionClass({ variant: "primary", size: "sm" }, "app-request-broker-control")}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                {needsValue ? "Save" : "Let it use this secret"}
              </button>
              <p className="text-[11px] text-muted-foreground">
                Stored encrypted in this Space&apos;s secrets. This Agent uses it right away and never sees it in chat.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
