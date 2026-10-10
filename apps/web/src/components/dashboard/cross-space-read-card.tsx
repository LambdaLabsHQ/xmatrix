"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, Loader2, X } from "lucide-react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import { actionClass } from "@/components/ui/action-tone";
import { errorFromResponse } from "@/lib/query/api-client";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { userErrorMessage } from "@/lib/user-facing-error";
import { AskCard, AskError } from "./ask-card";
import { refetchUnlessHumanPush } from "./workspace-resource-push";

/**
 * The approval card for a cross-Space read grant (docs/cross-space-read-grants.md).
 * The message carries only the grant reference, because everyone in the Run's
 * Channel sees it; the owner's card reads the target and reason from the Hub as
 * the owner. Everyone else sees that an owner decision is pending, nothing more.
 */
export interface CrossSpaceReadMetadata {
  grantId: string;
  spaceId: string;
  ownerUserId?: string;
  agentName?: string;
}

interface CrossSpaceReadGrant {
  channelId: string;
  scope: "channel" | "space";
  status: "pending" | "approved" | "denied" | "revoked" | "expired";
  reason?: string;
  agentName?: string;
  expiresAt: string;
  readCount: number;
}

export function crossSpaceReadMetadata(metadata: Record<string, unknown> | undefined): CrossSpaceReadMetadata | null {
  const value = metadata?.crossSpaceRead;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" && field.trim() ? field.trim() : undefined);
  const grantId = text(record.grantId);
  const spaceId = text(record.spaceId);
  if (!grantId || !spaceId) return null;
  return { grantId, spaceId, ownerUserId: text(record.ownerUserId), agentName: text(record.agentName) };
}

const STATUS_COPY: Record<Exclude<CrossSpaceReadGrant["status"], "pending">, string> = {
  approved: "Approved · read-only",
  denied: "Denied",
  revoked: "Revoked",
  expired: "Expired",
};

function grantQueryKey(userId: string, request: CrossSpaceReadMetadata) {
  return ["cross-space-read-grant", userId, request.spaceId, request.grantId];
}

function useGrantFetch(userId: string, token: string | null | undefined) {
  const fetch = useXMatrixQueryFetch(userId);
  return async (request: CrossSpaceReadMetadata, signal: AbortSignal): Promise<CrossSpaceReadGrant | null> => {
    const response = await fetch(WEB_PROXY_ROUTES.cross_space_read_grant(request.spaceId, request.grantId), {
      headers: { Authorization: `Bearer ${token}` }, signal, cache: "no-store",
    });
    if (response.status === 403 || response.status === 404) return null;
    if (!response.ok) throw await errorFromResponse(response);
    return (await response.json()).grant as CrossSpaceReadGrant;
  };
}

/**
 * The requests made from one Channel that wait for this viewer's decision, as
 * the Hub lists them. They join the Channel's Pending approvals dock beside
 * every other approval, however far back in the timeline their card is.
 */
export function useChannelPendingCrossSpaceReads(userId: string, channelId: string | undefined,
  token: string | null | undefined, enabled: boolean): CrossSpaceReadMetadata[] {
  const fetch = useXMatrixQueryFetch(userId);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["channel-pending-cross-space-reads", userId, channelId],
    enabled: Boolean(enabled && token && channelId && userId),
    retry: false,
    refetchInterval: () => refetchUnlessHumanPush(10_000),
    refetchOnWindowFocus: true,
    queryFn: async ({ signal }): Promise<CrossSpaceReadMetadata[]> => {
      const response = await fetch(WEB_PROXY_ROUTES.channel_pending_cross_space_reads(channelId!), {
        headers: { Authorization: `Bearer ${token}` }, signal, cache: "no-store",
      });
      // An older Hub, or a Channel this viewer cannot read, simply has nothing waiting.
      if (!response.ok) return [];
      const payload = await response.json() as { grants?: (CrossSpaceReadGrant & { id: string; spaceId: string;
        ownerUserId: string })[] };
      return (payload.grants ?? []).map((grant) => {
        const request = { grantId: grant.id, spaceId: grant.spaceId, ownerUserId: grant.ownerUserId,
          ...(grant.agentName ? { agentName: grant.agentName } : {}) };
        queryClient.setQueryData(grantQueryKey(userId, request), grant);
        return request;
      });
    },
  });
  return query.data ?? [];
}

export function CrossSpaceReadCard({ request, token, userId }: {
  request: CrossSpaceReadMetadata;
  token?: string | null;
  userId: string;
}) {
  const fetch = useXMatrixQueryFetch(userId);
  const readGrant = useGrantFetch(userId, token);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const isOwner = Boolean(request.ownerUserId && request.ownerUserId === userId);
  const queryKey = grantQueryKey(userId, request);
  const grantQuery = useQuery<CrossSpaceReadGrant | null>({
    queryKey,
    enabled: Boolean(token && isOwner),
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? refetchUnlessHumanPush(10_000) : false),
    queryFn: ({ signal }) => readGrant(request, signal),
  });
  const grant = grantQuery.data;

  async function decide(action: "approve" | "deny" | "revoke") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(WEB_PROXY_ROUTES.cross_space_read_grant_decision(request.spaceId, request.grantId), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(action === "approve" && narrow ? { action, scope: "channel" } : { action }),
      });
      if (!response.ok) throw await errorFromResponse(response);
      const payload = await response.json();
      queryClient.setQueryData(queryKey, payload.grant as CrossSpaceReadGrant);
      void queryClient.invalidateQueries({ queryKey: ["channel-pending-cross-space-reads", userId] });
    } catch (decisionError) {
      setError(userErrorMessage(decisionError, "Couldn't record your decision"));
    } finally {
      setBusy(false);
    }
  }

  const status = grant?.status ?? "pending";
  const agentName = grant?.agentName || request.agentName || "Agent";
  return (
    <AskCard
      who={agentName}
      kind="Read access"
      icon={<Eye className="size-3.5" />}
      open={isOwner && status === "pending"}
      question={`Let ${agentName} read another Space?`}
      detail={isOwner ? grant && <>
        {grant.scope === "space" ? "The whole Space of Channel " : "Channel "}
        <span className="font-mono [overflow-wrap:anywhere]">{grant.channelId}</span>
        {grant.scope === "space" ? "" : " and its threads"}, read-only, for this Run only
        {grant.reason && <> · “{grant.reason}”</>}
        <div>What it reads may be repeated in this Channel.</div>
        {status === "approved" && (
          <div>Until {new Date(grant.expiresAt).toLocaleString()} · {grant.readCount} reads so far</div>
        )}
      </> : "Only this Agent's owner sees what it asks to read, and decides."}
      status={!isOwner ? { tone: "secondary", label: "Owner decides" }
        : grant && status !== "pending" && { tone: status === "approved" ? "settled" : "alert", label: STATUS_COPY[status] }}
    >
      {isOwner && grantQuery.isLoading && <Loader2 className="mt-2 size-3.5 animate-spin text-muted-foreground" />}
      <AskError error={error} loadError={grantQuery.error} action="Couldn't load this access request"
        onRetry={() => void grantQuery.refetch()} />
      {isOwner && grant?.status === "pending" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("approve")}
            className={actionClass({ variant: "primary", size: "sm" })}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("deny")}
            className={actionClass({ variant: "secondary", size: "sm" })}
          >
            <X className="size-3.5" />
            Deny
          </button>
          {grant.scope === "space" && (
            <label className="ml-1 inline-flex items-center gap-1.5 text-xs text-foreground">
              <input type="checkbox" checked={narrow} disabled={busy} onChange={(event) => setNarrow(event.target.checked)} />
              Only this Channel
            </label>
          )}
        </div>
      )}
      {isOwner && grant?.status === "approved" && (
        <div className="mt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("revoke")}
            className={actionClass({ variant: "secondary", size: "sm" })}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
            Revoke now
          </button>
        </div>
      )}
    </AskCard>
  );
}
