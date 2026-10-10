"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Check, KeyRound, Loader2, Settings2 } from "lucide-react";
import {
  parseSecretAccessRequestCard, parseSecretRequestCard, WEB_PROXY_ROUTES,
  type SecretAccessRequestCard, type SecretRequestCard,
} from "@xmatrix/protocol";

import { actionClass } from "@/components/ui/action-tone";
import { errorFromResponse } from "@/lib/query/api-client";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { userErrorMessage } from "@/lib/user-facing-error";
import { AskCard, AskError } from "./ask-card";

/**
 * A card an Agent posts when it needs a Space secret it may not read yet. A
 * Space admin lets it use one the Space holds, or types the value of a new
 * one; the value goes from this browser to the Space's secrets under the
 * admin's session, and the Agent may read it at once.
 */
export function secretRequestMetadata(metadata: Record<string, unknown> | undefined): SecretRequestCard | null {
  return parseSecretRequestCard(metadata?.secretRequest);
}

/**
 * Opens the Space's secrets, where one is edited, rotated, given its access
 * rule and deleted. A secret card offers it to whoever may answer the card.
 */
const ManageSecretsContext = createContext<(() => void) | null>(null);
export const ManageSecretsProvider = ManageSecretsContext.Provider;

function ManageSecretsButton() {
  const manageSecrets = useContext(ManageSecretsContext);
  return manageSecrets && (
    <button type="button" onClick={manageSecrets} className={actionClass({ variant: "secondary", size: "sm" })}>
      <Settings2 className="size-3.5" />
      Manage
    </button>
  );
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
  const envName = status?.envName ?? request.envName;
  const reason = request.reason || request.description;
  return (
    <SecretAsk
      who={request.agentName}
      kind="Secret"
      question={<>
        {needsValue ? "Give" : "Let"} {request.agentName || "this Agent"} {needsValue ? "the secret" : "use the secret"}{" "}
        <span className="font-mono text-[0.92em]">{request.secretRef}</span>?
      </>}
      detail={<>
        {envName && <>Set as <span className="font-mono">{envName}</span></>}
        {envName && reason && " · "}
        {reason && <>“{reason}”</>}
      </>}
      settled={done && "In use"}
      canApprove={status && canApprove}
      query={statusQuery}
      error={error}
    >
      <form
        className="mt-3 space-y-2"
        onSubmit={(event) => { event.preventDefault(); void save(); }}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            placeholder={needsValue ? "Paste the value here" : "New value (optional)"}
            className="h-7 min-w-40 flex-1 rounded-md border border-border px-2 font-mono text-xs text-foreground"
            aria-label={`Value for secret ${request.secretRef}`}
          />
          <button
            type="submit"
            disabled={busy || (needsValue && !value.trim())}
            className={actionClass({ variant: "primary", size: "sm" })}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {needsValue ? "Save" : "Let it use this secret"}
          </button>
          <ManageSecretsButton />
        </div>
        <p className="text-xs text-muted-foreground">
          Stored encrypted in this Space&apos;s secrets. This Agent uses it right away and never sees it in chat.
        </p>
      </form>
    </SecretAsk>
  );
}

/**
 * What both secret cards share: the ask, whose answer it is, what went wrong,
 * and the way on to the Space's secrets. `children` are the answer's controls,
 * shown to a Space admin while the ask is open; `list` shows in every state.
 */
function SecretAsk({ who, kind, question, detail, settled, canApprove, query, error, list, children }: {
  who?: string;
  kind: string;
  question: ReactNode;
  detail?: ReactNode;
  /** How it ended, once it has. */
  settled: string | false;
  /** Whether this reader may answer it; undefined until the Hub has said. */
  canApprove: boolean | undefined;
  query: Pick<UseQueryResult<unknown>, "isLoading" | "error" | "refetch">;
  error: string | null;
  list?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AskCard
      who={who || "An Agent"}
      kind={kind}
      icon={<KeyRound className="size-3.5" />}
      open={canApprove === true && !settled}
      question={question}
      detail={detail}
      status={settled ? { tone: "settled", label: settled }
        : canApprove === false && { tone: "secondary", label: "A Space admin answers" }}
    >
      {query.isLoading && <Loader2 className="mt-2 size-3.5 animate-spin text-muted-foreground" />}
      <AskError error={error} loadError={query.error} action="Couldn't load this secret request"
        onRetry={() => void query.refetch()} />
      {list}
      {canApprove && (settled ? <div className="mt-3"><ManageSecretsButton /></div> : children)}
    </AskCard>
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
 * nothing itself and sees no value. While it waits, every name shows in full
 * with its tick; one secret is named by the question alone. Once answered the
 * names fold to a line, so a long list does not stay spread over the stream.
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

  const lone = request.secretRefs.length === 1 ? request.secretRefs[0] : undefined;
  return (
    <SecretAsk
      who={request.agentName}
      kind="Secret access"
      question={lone
        ? <>Let Agents read <span className="font-mono text-[0.92em]">{lone}</span> without asking?</>
        : `Let Agents read these ${request.secretRefs.length} secrets without asking?`}
      detail={request.reason && <>“{request.reason}”</>}
      settled={done && "Automatic"}
      canApprove={status && canApprove}
      query={statusQuery}
      error={error}
      list={status && !lone && (done ? (
        <details className="mt-2 text-[13px]">
          <summary className="cursor-pointer text-muted-foreground">{request.secretRefs.length} secrets</summary>
          <ul className="mt-1 space-y-0.5 font-mono [overflow-wrap:anywhere]">
            {request.secretRefs.map((ref) => <li key={ref}>{ref}</li>)}
          </ul>
        </details>
      ) : (
        <ul className="mt-2 space-y-1">
          {request.secretRefs.map((ref) => {
            const held = status.access.get(ref);
            return (
              <li key={ref}>
                <label className="flex min-w-0 items-start gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 shrink-0"
                    checked={held?.automatic === true || (held !== undefined && !declined.has(ref))}
                    disabled={busy || !canApprove || held?.automatic !== false}
                    onChange={(event) => setDeclined((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.delete(ref); else next.add(ref);
                      return next;
                    })}
                    aria-label={`Read ${ref} without asking`}
                  />
                  <span className="min-w-0 font-mono text-foreground [overflow-wrap:anywhere]">{ref}</span>
                  {held?.automatic !== false && (
                    <span className="shrink-0 text-muted-foreground">
                      {held ? "Already automatic" : "Not saved in this Space"}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      ))}
    >
      <div className="mt-3 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || chosen.length === 0}
            onClick={() => void approve()}
            className={actionClass({ variant: "primary", size: "sm" })}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {chosen.length === 1 ? "Let Agents read it without asking"
              : `Let Agents read these ${chosen.length} without asking`}
          </button>
          <ManageSecretsButton />
        </div>
        <p className="text-xs text-muted-foreground">
          Any Agent in this Space then reads a ticked secret when it needs it, with no card. Change it back in Space settings.
        </p>
      </div>
    </SecretAsk>
  );
}
