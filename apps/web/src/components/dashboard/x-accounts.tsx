"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type SpaceMember } from "@xmatrix/protocol";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { Button } from "@/components/ui/button";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

interface XAccount {
  id: string;
  username: string;
  generation: string;
  ownerUserId: string;
  expiresAt: string;
  needsReconnect: boolean;
}

export function XAccounts({ spaceId, token, userId, members, adding, canAdd, onAdd, onReconnect, onChanged }: {
  spaceId: string;
  token: string;
  userId: string;
  members: SpaceMember[];
  adding: boolean;
  canAdd: boolean;
  onAdd: () => void;
  onReconnect: (accountId: string) => void;
  onChanged: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const key = xmatrixQueryKeys.domain({ userId }, "x-accounts", [spaceId]);
  const accounts = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => xmatrixApiRequest<{ accounts: XAccount[] }>({
      url: WEB_PROXY_ROUTES.space_app_connection_x_accounts(spaceId), token, signal,
    }).then((payload) => payload.accounts),
  });
  const remove = useMutation({
    mutationKey: [...key, "remove"],
    mutationFn: (account: XAccount) => xmatrixApiRequest<{ accounts: XAccount[] }>({
      url: WEB_PROXY_ROUTES.space_app_connection_x_account(spaceId, account.id),
      method: "DELETE", token, body: { generation: account.generation },
    }),
    onSuccess: async (payload) => {
      queryClient.setQueryData(key, payload.accounts);
      await onChanged();
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const ownerLabel = (ownerUserId: string) => {
    if (ownerUserId === userId) return "You";
    const member = members.find((candidate) => candidate.userId === ownerUserId);
    return member?.name || member?.email || "Former Space member";
  };
  const busy = adding || remove.isPending;

  return (
    <div className="space-y-3" data-testid="x-accounts">
      <p className="text-xs leading-5 text-muted-foreground">
        Authorize your company and personal accounts separately. Each account can be used only by
        the member who connected it and their Agents. Up to four accounts can be connected.
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        Choose an account for every action. Publishing asks for approval of each request by default.
        Action results appear in the calling Channel, where its members can read them.
      </p>
      <p className="text-xs leading-5 text-muted-foreground">Quote posts require an X Enterprise API plan.</p>
      {accounts.isPending ? <p className="text-xs text-muted-foreground">Loading X accounts…</p> : null}
      {remove.error || accounts.error ? (
        <p className="text-sm font-medium text-destructive" role="alert">{(remove.error ?? accounts.error)?.message}</p>
      ) : null}
      <ul className="divide-y divide-border/60 text-sm">
        {(accounts.data ?? []).map((account) => (
          <li key={`${account.id}:${account.generation}`} className="flex flex-wrap items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">@{account.username}</p>
              <p className="text-xs text-muted-foreground">Connected by {ownerLabel(account.ownerUserId)}</p>
              {account.needsReconnect ? <p className="text-xs text-destructive">Authorize this account again to reconnect.</p> : null}
            </div>
            {account.ownerUserId === userId ? (
              <Button size="xs" variant="ghost" disabled={busy || !canAdd}
                aria-label={`Reconnect @${account.username}`} onClick={() => onReconnect(account.id)}>
                <RefreshCw /> Reconnect
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" aria-label={`Remove @${account.username}`} disabled={busy}
              onClick={() => {
                if (window.confirm(`Remove @${account.username} from this Space? Pending publishing approvals for this connection will stop working.`)) {
                  remove.mutate(account);
                }
              }}>
              {remove.isPending && remove.variables.id === account.id
                ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <Trash2 />}
              Remove
            </Button>
          </li>
        ))}
        {accounts.data?.length === 0 ? <li className="py-2 text-muted-foreground">No X account is connected.</li> : null}
      </ul>
      {!canAdd ? <p className="text-xs text-muted-foreground">The company X application must be configured before accounts can connect.</p> : null}
      <Button size="sm" type="button" disabled={busy || !canAdd || (accounts.data?.length ?? 0) >= 4} onClick={onAdd}>
        {adding ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <Plus />} Add X account
      </Button>
    </div>
  );
}
