"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, Loader2, X } from "lucide-react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import { actionClass } from "@/components/ui/action-tone";
import { statusChipClass } from "@/components/ui/status-tone";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
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

const STATUS_COPY: Record<CrossSpaceReadGrant["status"], string> = {
  pending: "Waiting for the owner",
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
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Grant is unavailable");
    return payload.grant as CrossSpaceReadGrant;
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
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Decision failed");
      queryClient.setQueryData(queryKey, payload.grant as CrossSpaceReadGrant);
      void queryClient.invalidateQueries({ queryKey: ["channel-pending-cross-space-reads", userId] });
    } catch (decisionError) {
      setError((decisionError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const status = grant?.status ?? "pending";
  const agentName = grant?.agentName || request.agentName || "Agent";
  return (
    <div className="app-request-broker-card mt-2 w-full max-w-2xl rounded-md border border-border bg-muted/35 p-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="app-request-broker-icon mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
          <Eye className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-sm font-black">Read access outside this Space</span>
            {(grant || !isOwner) && (
              <span className={statusChipClass(status === "pending" ? "attention"
                : status === "approved" ? "settled" : "alert", "app-request-broker-status px-1.5 py-0.5 text-[11px] font-bold")}>
                {grant ? STATUS_COPY[status] : "Owner decides"}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{agentName}</div>
          {!isOwner && (
            <p className="mt-2 text-xs text-muted-foreground">
              Only this Agent&apos;s owner sees what it asks to read, and decides.
            </p>
          )}
          {isOwner && grant && (
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <div>
                Reads: <span className="break-all font-mono text-foreground">{grant.scope === "space"
                  ? `the whole Space of Channel ${grant.channelId}` : `Channel ${grant.channelId} and its threads`}</span>
              </div>
              {grant.reason && <div>Reason: {grant.reason}</div>}
              <div>Read-only, for this Run only. What it reads may be repeated in this Channel.</div>
              {status === "approved" && (
                <div>Until {new Date(grant.expiresAt).toLocaleString()} · {grant.readCount} reads so far</div>
              )}
            </div>
          )}
          {isOwner && grantQuery.isLoading && <Loader2 className="mt-2 size-3.5 animate-spin text-muted-foreground" />}
          {(error || grantQuery.error) && (
            <div role="alert" className="mt-2 text-xs text-destructive">{error || grantQuery.error?.message}</div>
          )}
          {isOwner && grant?.status === "pending" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {grant.scope === "space" && (
                <label className="inline-flex items-center gap-1.5 text-xs text-foreground">
                  <input type="checkbox" checked={narrow} disabled={busy} onChange={(event) => setNarrow(event.target.checked)} />
                  Only this Channel
                </label>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide("approve")}
                className={actionClass({ variant: "primary", size: "sm" }, "app-request-broker-control")}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide("deny")}
                className={actionClass({ variant: "secondary", size: "sm" }, "app-request-broker-control")}
              >
                <X className="size-3.5" />
                Deny
              </button>
            </div>
          )}
          {isOwner && grant?.status === "approved" && (
            <div className="mt-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide("revoke")}
                className={actionClass({ variant: "secondary", size: "sm" }, "app-request-broker-control")}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                Revoke now
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
