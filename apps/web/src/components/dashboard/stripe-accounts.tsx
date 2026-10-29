"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type StripeAccountView, type StripeAccountPage } from "@xmatrix/protocol";
import { Loader2, Trash2 } from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { xmatrixApiRequest, unexpectedResponse } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { ConnectorAction, ConnectorAddRow, ConnectorRow, ConnectorRows, ConnectorSection } from "./connector-page";

/** Stripe's account picker grants one merchant at a time; every return adds to this Space's list. */
export function StripeAccounts({ spaceId, token, userId, adding, canAdd, hideWhenEmpty, onAdd, onChanged }: {
  spaceId: string; token: string; userId: string; adding: boolean; canAdd: boolean; hideWhenEmpty: boolean;
  onAdd: () => void; onChanged: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const key = xmatrixQueryKeys.domain({ userId }, "stripe-accounts", [spaceId]);
  const accounts = useInfiniteQuery({ queryKey: key, initialPageParam: undefined as string | undefined, refetchOnMount: "always",
    queryFn: ({ pageParam, signal }) => xmatrixApiRequest<StripeAccountPage>({ token, signal,
      url: WEB_PROXY_ROUTES.space_app_connection_stripe_accounts(spaceId) + (pageParam ? `?after=${encodeURIComponent(pageParam)}` : ""),
    }).then(page => {
      if (!Array.isArray(page.accounts) || (page.after !== null && typeof page.after !== "string")) throw unexpectedResponse("Stripe accounts");
      return page;
    }), getNextPageParam: page => page.after ?? undefined });
  const remove = useMutation({ mutationKey: [...key, "remove"],
    mutationFn: (account: StripeAccountView) => xmatrixApiRequest({ token, method: "DELETE",
      url: WEB_PROXY_ROUTES.space_app_connection_stripe_account(spaceId, account.id), body: { generation: account.generation } }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: key }); await onChanged(); },
    onError: () => void queryClient.invalidateQueries({ queryKey: key }) });
  const rows = accounts.data?.pages.flatMap(page => page.accounts) ?? [];
  if (hideWhenEmpty && !rows.length && !accounts.error) return null;
  const busy = adding || remove.isPending;
  return (
    <ConnectorSection title="Stripe accounts" testId="stripe-accounts"
      note="Add each Stripe account you want in this Space. They stay connected together and share this connection's channel subscriptions.">
      {accounts.isPending ? <p className="py-2.5 text-[13px] text-muted-foreground">Loading Stripe accounts…</p> : null}
      <ConnectorRows>
        {rows.map(account => (
          <ConnectorRow key={account.id} title={account.name}
            meta={account.status === "reconnect" ? "Reconnect this account" : `Connected ${new Date(account.connectedAt).toLocaleDateString()}`}
            trailing={<ConnectorAction aria-label={`Remove ${account.name}`} disabled={busy}
              onClick={() => { if (window.confirm(`Remove ${account.name} from this Space? Its events stop here; other Stripe accounts stay connected.`)) remove.mutate(account); }}>
              {remove.isPending && remove.variables.id === account.id
                ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} Remove
            </ConnectorAction>} />
        ))}
        <ConnectorAddRow label="Add Stripe account" onClick={onAdd} disabled={busy || !canAdd} busy={adding} />
      </ConnectorRows>
      {accounts.hasNextPage ? <ConnectorAction disabled={accounts.isFetchingNextPage} onClick={() => void accounts.fetchNextPage()}>Show more accounts</ConnectorAction> : null}
      {remove.error || accounts.error ? <p role="alert" className="mt-1 text-[13px] font-medium text-destructive">{(remove.error ?? accounts.error)?.message}</p> : null}
    </ConnectorSection>
  );
}
