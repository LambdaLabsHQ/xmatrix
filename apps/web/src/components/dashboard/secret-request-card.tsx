"use client";

import { createContext, useContext, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Loader2, Settings2 } from "lucide-react";
import { parseSecretRequestCard, WEB_PROXY_ROUTES, type SecretRequestCard } from "@xmatrix/protocol";

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
 * rule and deleted. A card offers it to whoever may answer the card.
 */
const ManageSecretsContext = createContext<(() => void) | null>(null);
export const ManageSecretsProvider = ManageSecretsContext.Provider;

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
  const manageSecrets = useContext(ManageSecretsContext);
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
  const manage = manageSecrets && canApprove && (
    <button type="button" onClick={manageSecrets} className={actionClass({ variant: "secondary", size: "sm" })}>
      <Settings2 className="size-3.5" />
      Manage
    </button>
  );
  const envName = status?.envName ?? request.envName;
  const reason = request.reason || request.description;
  return (
    <AskCard
      who={request.agentName || "An Agent"}
      kind="Secret"
      icon={<KeyRound className="size-3.5" />}
      open={Boolean(status) && !done && canApprove}
      question={<>
        {needsValue ? "Give" : "Let"} {request.agentName || "this Agent"} {needsValue ? "the secret" : "use the secret"}{" "}
        <span className="font-mono text-[0.92em]">{request.secretRef}</span>?
      </>}
      detail={<>
        {envName && <>Set as <span className="font-mono">{envName}</span></>}
        {envName && reason && " · "}
        {reason && <>“{reason}”</>}
      </>}
      status={status && (done ? { tone: "settled", label: "In use" }
        : !canApprove && { tone: "secondary", label: "A Space admin answers" })}
    >
      {statusQuery.isLoading && <Loader2 className="mt-2 size-3.5 animate-spin text-muted-foreground" />}
      <AskError error={error} loadError={statusQuery.error} action="Couldn't load this secret request"
        onRetry={() => void statusQuery.refetch()} />
      {status && !done && canApprove && (
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
            {manage}
          </div>
          <p className="text-xs text-muted-foreground">
            Stored encrypted in this Space&apos;s secrets. This Agent uses it right away and never sees it in chat.
          </p>
        </form>
      )}
      {done && manage && <div className="mt-3">{manage}</div>}
    </AskCard>
  );
}
