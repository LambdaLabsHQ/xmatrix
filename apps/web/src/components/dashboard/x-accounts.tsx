"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type SpaceMember } from "@xmatrix/protocol";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { ConnectorAction, ConnectorAddRow, ConnectorEmpty, ConnectorFold, ConnectorRow, ConnectorRows, ConnectorSection } from "./connector-page";
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
    <ConnectorSection title="X accounts" testId="x-accounts"
      note="Each account is used only by the member who connected it and their Agents. Publishing asks for approval each time by default.">
      {accounts.isPending ? <p className="py-2.5 text-[13px] text-muted-foreground">Loading X accounts…</p> : null}
      <ConnectorRows>
        {(accounts.data ?? []).map((account) => (
          <ConnectorRow key={`${account.id}:${account.generation}`} title={`@${account.username}`}
            meta={<>
              Connected by {ownerLabel(account.ownerUserId)}
              {account.needsReconnect ? <span className="block text-destructive">Authorize this account again to reconnect.</span> : null}
            </>}
            trailing={<>
              {account.ownerUserId === userId ? (
                <ConnectorAction disabled={busy || !canAdd} aria-label={`Reconnect @${account.username}`}
                  onClick={() => onReconnect(account.id)}>
                  <RefreshCw className="size-3.5" /> Reconnect
                </ConnectorAction>
              ) : null}
              <ConnectorAction aria-label={`Remove @${account.username}`} disabled={busy}
                onClick={() => {
                  if (window.confirm(`Remove @${account.username} from this Space? Pending publishing approvals for this connection will stop working.`)) {
                    remove.mutate(account);
                  }
                }}>
                {remove.isPending && remove.variables.id === account.id
                  ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                Remove
              </ConnectorAction>
            </>} />
        ))}
        {accounts.data?.length === 0 ? <ConnectorEmpty>No X account is connected.</ConnectorEmpty> : null}
        <ConnectorAddRow label="Add X account" onClick={onAdd} disabled={busy || !canAdd} busy={adding} />
      </ConnectorRows>
      {!canAdd ? <p className="mt-1 text-[13px] text-muted-foreground">The company X application must be configured before accounts can connect.</p> : null}
      {remove.error || accounts.error ? (
        <p className="mt-1 text-[13px] font-medium text-destructive" role="alert">{(remove.error ?? accounts.error)?.message}</p>
      ) : null}
      <div className="mt-2">
        <ConnectorFold summary="Company and personal accounts">
          <div className="max-w-[62ch] space-y-2 pb-1 text-[13px] leading-[1.45] text-muted-foreground">
            <p>Authorize your company and personal accounts separately, one Add X account each.</p>
            <p>Every action names its account. Results appear in the calling Channel, where its members can read them.
              Quote posts require an X Enterprise API plan.</p>
          </div>
        </ConnectorFold>
      </div>
    </ConnectorSection>
  );
}
