"use client";

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Check, KeyRound, Loader2 } from "lucide-react";
import {
  parseSecretAccessRequestCard, parseSecretRequestCard, WEB_PROXY_ROUTES,
  type SecretAccessRequestCard, type SecretRequestCard,
} from "@xmatrix/protocol";

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

export function SecretRequestCardView({ request, messageId, token, userId }: {
  request: SecretRequestCard;
  /** The card's own message, so answering it clears the wait this card declared and no other. */
  messageId?: string;
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
        body: JSON.stringify({ ...request, ...(messageId ? { messageId } : {}), ...(value.trim() ? { value } : {}) }),
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
    <SecretCardFrame
      title={`Secret for ${request.agentName || "an Agent"}`}
      chip={status && { settled: done, label: done ? "In use" : !canApprove ? "A Space admin answers"
        : status.saved ? "Waiting for your approval" : "Waiting for the value" }}
      note={request.reason || request.description}
      query={statusQuery}
      error={error}
      adminOnly={Boolean(status) && !done && !canApprove}
      lead={(
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{request.secretRef}</span>
          {(status?.envName ?? request.envName) && <>
            <span>as</span>
            <span className="font-mono text-foreground">{status?.envName ?? request.envName}</span>
          </>}
        </div>
      )}
    >
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
    </SecretCardFrame>
  );
}

/** What both secret cards share: the key, a title with its state, the Agent's reason and what went wrong. */
function SecretCardFrame({ title, chip, lead, note, query, error, adminOnly, children }: {
  title: string;
  chip?: { settled: boolean; label: string };
  lead?: ReactNode;
  note?: string;
  query: Pick<UseQueryResult<unknown>, "isLoading" | "error" | "refetch">;
  error: string | null;
  adminOnly: boolean;
  children: ReactNode;
}) {
  return (
    <div className="app-request-broker-card mt-2 w-full max-w-2xl rounded-md border border-border bg-muted/35 p-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="app-request-broker-icon mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-sm font-black">{title}</span>
            {chip && (
              <span className={statusChipClass(chip.settled ? "settled" : "attention",
                "app-request-broker-status px-1.5 py-0.5 text-[11px] font-bold")}>
                {chip.label}
              </span>
            )}
          </div>
          {lead}
          {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
          {adminOnly && <p className="mt-2 text-xs text-muted-foreground">Only a Space admin can answer this.</p>}
          {query.isLoading && <Loader2 className="mt-2 size-3.5 animate-spin text-muted-foreground" />}
          {error ? <div role="alert" className="mt-2 text-xs text-destructive">{error}</div>
            : <ErrorNotice error={query.error} action="Couldn't load this secret request"
              className="mt-2 text-xs text-destructive" onRetry={() => void query.refetch()} />}
          {children}
        </div>
      </div>
    </div>
  );
}

export function secretAccessRequestMetadata(metadata: Record<string, unknown> | undefined): SecretAccessRequestCard | null {
  return parseSecretAccessRequestCard(metadata?.secretAccessRequest);
}

interface SecretAccessStatus {
  /** How each named secret the Space holds is read now. */
  access: Map<string, { automatic: boolean; envName?: string }>;
  canApprove: boolean;
}

function accessStatus(payload: Record<string, unknown>): SecretAccessStatus {
  const rows = Array.isArray(payload.secrets) ? payload.secrets as Array<Record<string, unknown>> : [];
  return { canApprove: payload.canApprove === true,
    access: new Map(rows.filter((row) => typeof row.secretRef === "string").map((row) => [String(row.secretRef),
      { automatic: row.access === "auto", ...(typeof row.envName === "string" ? { envName: row.envName } : {}) }])) };
}

/**
 * A card an Agent posts asking that secrets be read without asking each time.
 * A Space admin ticks the ones to open up and answers once; the Agent changes
 * nothing itself and sees no value.
 */
export function SecretAccessRequestCardView({ request, messageId, token, userId }: {
  request: SecretAccessRequestCard;
  /** The card's own message, so answering it clears the wait this card declared and no other. */
  messageId?: string;
  token?: string | null;
  userId: string;
}) {
  const fetch = useXMatrixQueryFetch(userId);
  const queryClient = useQueryClient();
  const [declined, setDeclined] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryKey = ["secret-access-request-status", userId, request.runId, request.secretRefs.join("\n")];
  const call = async (route: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    const response = await fetch(route, {
      method: "POST", cache: "no-store", ...(signal ? { signal } : {}),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await errorFromResponse(response);
    return accessStatus(await response.json());
  };
  const statusQuery = useQuery<SecretAccessStatus>({
    queryKey,
    enabled: Boolean(token),
    retry: false,
    queryFn: ({ signal }) => call(WEB_PROXY_ROUTES.secret_request_status,
      { runId: request.runId, channelId: request.channelId, secretRefs: request.secretRefs }, signal),
  });
  const status = statusQuery.data;
  const canApprove = status?.canApprove === true;
  const asking = request.secretRefs.filter((ref) => status?.access.get(ref)?.automatic === false);
  const chosen = asking.filter((ref) => !declined.has(ref));
  const done = Boolean(status) && asking.length === 0;

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(queryKey, await call(WEB_PROXY_ROUTES.secret_request_fulfill,
        { runId: request.runId, channelId: request.channelId, secretRefs: chosen, ...(messageId ? { messageId } : {}) }));
    } catch (approveError) {
      setError(userErrorMessage(approveError, "Couldn't change these secrets"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SecretCardFrame
      title="Secrets Agents read without asking"
      chip={status && { settled: done, label: done ? "Automatic" : !canApprove ? "A Space admin answers"
        : "Waiting for your approval" }}
      note={request.reason}
      query={statusQuery}
      error={error}
      adminOnly={Boolean(status) && !done && !canApprove}
    >
      {status && (
        <ul className="mt-2 space-y-1">
          {request.secretRefs.map((ref) => {
            const held = status.access.get(ref);
            return (
              <li key={ref}>
                <label className="flex min-w-0 items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="app-request-broker-control size-3.5 shrink-0"
                    checked={held?.automatic === true || (held !== undefined && !declined.has(ref))}
                    disabled={busy || !canApprove || held?.automatic !== false}
                    onChange={(event) => setDeclined((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.delete(ref); else next.add(ref);
                      return next;
                    })}
                    aria-label={`Read ${ref} without asking`}
                  />
                  <span className="min-w-0 truncate font-mono text-foreground">{ref}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {!held ? "Not saved in this Space" : held.automatic ? "Automatic" : held.envName}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {status && !done && canApprove && (
        <div className="mt-3 space-y-2">
          <button
            type="button"
            disabled={busy || chosen.length === 0}
            onClick={() => void approve()}
            className={actionClass({ variant: "primary", size: "sm" }, "app-request-broker-control")}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {chosen.length === 1 ? "Let Agents read it without asking"
              : `Let Agents read these ${chosen.length} without asking`}
          </button>
          <p className="text-[11px] text-muted-foreground">
            Any Agent in this Space then reads a ticked secret when it needs it, with no card. Change it back in Space settings.
          </p>
        </div>
      )}
    </SecretCardFrame>
  );
}
