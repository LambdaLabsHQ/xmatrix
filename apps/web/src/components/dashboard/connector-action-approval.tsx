"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Send, X } from "lucide-react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { actionClass } from "@/components/ui/action-tone";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";
import { AskCard } from "./ask-card";
import { refetchUnlessHumanPush } from "./workspace-resource-push";

interface ActionApproval {
  requestId: string;
  channelId: string;
  providerId: string;
  actionId: string;
  requestedBy: string;
  preview: Record<string, string>;
  expiresAt: string;
}

function queryKey(userId: string, channelId?: string) { return ["connector-action-approvals", userId, channelId]; }

/**
 * The requests waiting in one Channel for this admin's answer. The Hub
 * announces a request staged or answered (`connector_action_requests`), so an
 * open Channel reads the list then, and on a timer only while the socket is down.
 */
export function useConnectorActionApprovals(userId: string, channelId: string | undefined,
  token: string | null | undefined, enabled: boolean): ActionApproval[] {
  const query = useQuery({
    queryKey: queryKey(userId, channelId), enabled: Boolean(enabled && token && channelId && userId), retry: false,
    refetchInterval: () => refetchUnlessHumanPush(10_000),
    refetchOnWindowFocus: true,
    queryFn: ({ signal }) => xmatrixApiRequest<{ requests: ActionApproval[] }>({
      url: WEB_PROXY_ROUTES.channel_connector_action_requests(channelId!), token: token!, signal,
    }).then(result => result.requests ?? []),
  });
  return query.data ?? [];
}

/** Preview is fetched as a current admin, never taken from a message's caller-controlled metadata. */
export function ConnectorActionApproval({ request, token, userId }: {
  request: ActionApproval; token: string | null | undefined; userId: string;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);
  async function decide(decision: "allow" | "disallow") {
    setBusy(true); setError(null);
    try {
      const result = await xmatrixApiRequest<{ request: { status: string } }>({
        url: WEB_PROXY_ROUTES.channel_connector_action_request(request.channelId, request.requestId),
        token: token!, method: "POST", body: { decision },
      });
      setSettled(result.request.status);
      void queryClient.invalidateQueries({ queryKey: queryKey(userId, request.channelId) });
    } catch (failure) { setError(userErrorMessage(failure, "Couldn't record your decision")); }
    finally { setBusy(false); }
  }
  return (
    <AskCard who={request.providerId} kind="Action approval" icon={<Send className="size-3.5" />}
      open={!settled} question={request.providerId === "gmail" ? "Send this email?" : `Allow ${request.providerId} ${request.actionId}?`}
      detail="Your answer covers this request only. The next request asks again."
      status={settled ? { tone: "settled", label: settled } : null}>
      <dl className="mt-2 space-y-1 text-sm">
        {Object.entries(request.preview).filter(([key]) => key !== "body" && key !== "text").map(([key, value]) => (
          <div key={key}><dt className="inline font-semibold capitalize">{key}: </dt><dd className="inline [overflow-wrap:anywhere]">{value}</dd></div>
        ))}
      </dl>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{request.preview.body ?? request.preview.text}</pre>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      {!settled && <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy} onClick={() => void decide("allow")} className={actionClass({ variant: "primary", size: "sm" })}>
          {busy ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Allow once
        </button>
        <button type="button" disabled={busy} onClick={() => void decide("disallow")} className={actionClass({ variant: "secondary", size: "sm" })}>
          <X className="size-3.5" /> Disallow
        </button>
      </div>}
    </AskCard>
  );
}
