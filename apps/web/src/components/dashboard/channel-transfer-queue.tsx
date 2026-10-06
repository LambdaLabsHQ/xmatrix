"use client";
import { actionClass } from "@/components/ui/action-tone";
import { useState } from "react";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";

type Proposal = {
  id: string; sourceSpaceId: string; targetSpaceId: string; channelId: string;
  sourceName: string; targetName: string; status: string; expiresAt: string;
  tree: { id: string; name: string }[]; lostUserIds: string[]; lostAgentIds: string[]; lostUsers?: { id: string; name: string }[];
  outbound: { userId: string } | null; inbound: { userId: string } | null;
  canAckOutbound: boolean; canAckInbound: boolean;
};

export function ChannelTransferQueue({ token, userId, spaceId, channelId, enabled = true }: {
  token?: string | null; userId: string; spaceId: string; channelId?: string; enabled?: boolean;
}) {
  const client = useQueryClient();
  const fetch = useXMatrixQueryFetch(userId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["channel-transfers", userId, spaceId, channelId ?? ""],
    enabled: Boolean(enabled && token && spaceId), refetchInterval: 15_000,
    queryFn: async ({ signal }) => {
      const response = await fetch(WEB_PROXY_ROUTES.space_channel_transfers(spaceId) +
        (channelId ? `?channelId=${encodeURIComponent(channelId)}` : ""), {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load transfer proposals");
      return payload.proposals as Proposal[];
    },
  });
  async function acknowledge(proposal: Proposal, role: "outbound" | "inbound") {
    if (busy) return;
    setBusy(`${proposal.id}:${role}`); setError(null);
    try {
      const response = await fetch(WEB_PROXY_ROUTES.channel_transfer_ack(proposal.sourceSpaceId, proposal.id), {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Confirmation failed");
      await client.invalidateQueries({ queryKey: ["channel-transfers", userId] });
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); }
  }
  if (!enabled) return null;
  if (!query.data?.length && !query.error) return null;
  return <section aria-label="Channel transfer confirmations" className="max-h-80 overflow-auto border-b border-border p-3 text-sm">
    <h3 className="font-semibold">Channel transfers</h3>
    {(error || query.error) && <p role="alert" className="text-destructive">{error || query.error?.message}</p>}
    {query.data?.map((proposal) => {
      const expired = new Date(proposal.expiresAt).getTime() <= Date.now();
      return <article key={proposal.id} className="space-y-2 border-b border-border py-3 last:border-0">
        <p className="font-medium">{proposal.tree.find((item) => item.id === proposal.channelId)?.name} · {proposal.sourceName} → {proposal.targetName}</p>
        <details><summary>{proposal.tree.length} Channels · review access changes</summary>
          <ul>{proposal.tree.map((item) => <li key={item.id}>{item.name} <span className="text-muted-foreground">({item.id})</span></li>)}</ul>
          <p>People losing access: {(proposal.lostUsers?.map((person) => `${person.name} (${person.id})`) ?? proposal.lostUserIds).join(", ") || "None"}</p>
          <p>Agents losing access: {proposal.lostAgentIds.join(", ") || "None"}</p>
        </details>
        <p>Outbound: {proposal.outbound ? `confirmed by ${proposal.outbound.userId}` : "awaiting source admin"}. Inbound: {proposal.inbound ? `confirmed by ${proposal.inbound.userId}` : "awaiting target admin"}.</p>
        {proposal.status === "completed" ? <p>Transfer completed. <button className="underline" onClick={() => window.location.reload()}>Refresh channels</button></p>
          : expired ? <p>Expired. Create a new proposal.</p> : <div className="flex flex-wrap gap-2">
            {(["outbound", "inbound"] as const).map((role) => <button key={role} type="button"
              className={actionClass({ variant: "secondary", size: "md" })}
              disabled={Boolean(busy) || Boolean(proposal[role]) || !(role === "outbound" ? proposal.canAckOutbound : proposal.canAckInbound)}
              onClick={() => void acknowledge(proposal, role)}>
              {role === "outbound" ? "Confirm outbound" : "Confirm inbound"}
            </button>)}
            {proposal.outbound && proposal.inbound && <button type="button" disabled={Boolean(busy)}
              className={actionClass({ variant: "secondary", size: "md" })} onClick={() => void acknowledge(proposal,
                proposal.canAckOutbound ? "outbound" : "inbound")}>Retry confirmed transfer</button>}
          </div>}
      </article>;
    })}
  </section>;
}
