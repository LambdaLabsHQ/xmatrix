"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type SpaceMember } from "@xmatrix/protocol";
import { Loader2, Trash2 } from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { ConnectorAction, ConnectorAddRow, ConnectorEmpty, ConnectorFold, ConnectorRow, ConnectorRows, ConnectorSection } from "./connector-page";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

/* The Cloudflare connection's OAuth logins: each Connect adds one, so a Space
   reaches accounts that belong to different Cloudflare users. Commands pick an
   account by id; the logins only decide which accounts are reachable. */

interface CloudflareLogin {
  id: string;
  accounts: Array<{ id: string; name: string }>;
  connectedBy: string;
  connectedAt: string;
}

export function CloudflareLogins({ spaceId, token, userId, members, adding, canAdd, onAdd, onChanged }: {
  spaceId: string;
  token: string;
  userId: string;
  members: SpaceMember[];
  adding: boolean;
  canAdd: boolean;
  onAdd: () => void;
  onChanged: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const key = xmatrixQueryKeys.domain({ userId }, "cloudflare-logins", [spaceId]);
  const logins = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => xmatrixApiRequest<{ logins: CloudflareLogin[] }>({
      url: WEB_PROXY_ROUTES.space_app_connection_cloudflare_logins(spaceId), token, signal,
    }).then((payload) => payload.logins),
  });
  const remove = useMutation({
    mutationKey: [...key, "remove"],
    mutationFn: (login: CloudflareLogin) => xmatrixApiRequest<{ logins: CloudflareLogin[] }>({
      url: WEB_PROXY_ROUTES.space_app_connection_cloudflare_login(spaceId, login.id), method: "DELETE", token,
    }),
    onSuccess: async (payload) => {
      queryClient.setQueryData(key, payload.logins);
      await onChanged();
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const connectedBy = (id: string) => {
    if (id === userId) return "you";
    const member = members.find((candidate) => candidate.userId === id);
    return member?.name || member?.email || "a former Space member";
  };
  const label = (login: CloudflareLogin) => login.accounts.map((account) => account.name || account.id).join(", ") || "Cloudflare login";
  const busy = adding || remove.isPending;

  return (
    <ConnectorSection title="Cloudflare logins" testId="cloudflare-logins"
      note="Each login reaches the accounts of one Cloudflare user. Commands use the default account unless they name another.">
      {logins.isPending ? <p className="py-2.5 text-[13px] text-muted-foreground">Loading Cloudflare logins…</p> : null}
      <ConnectorRows>
        {(logins.data ?? []).map((login) => (
          <ConnectorRow key={login.id} title={label(login)}
            meta={`Connected by ${connectedBy(login.connectedBy)} on ${new Date(login.connectedAt).toLocaleDateString()}`}
            trailing={(
              <ConnectorAction aria-label={`Remove ${label(login)}`} disabled={busy}
                onClick={() => {
                  if (window.confirm(`Remove the Cloudflare login for ${label(login)}? Commands and alerts for its accounts stop working.`)) {
                    remove.mutate(login);
                  }
                }}>
                {remove.isPending && remove.variables.id === login.id
                  ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                Remove
              </ConnectorAction>
            )} />
        ))}
        {logins.data?.length === 0 ? <ConnectorEmpty>No Cloudflare login is connected.</ConnectorEmpty> : null}
        <ConnectorAddRow label="Add Cloudflare login" onClick={onAdd} disabled={busy || !canAdd} busy={adding} />
      </ConnectorRows>
      {!canAdd ? <p className="mt-1 text-[13px] text-muted-foreground">Cloudflare one-click connect must be configured before logins can be added.</p> : null}
      {remove.error || logins.error ? (
        <p className="mt-1 text-[13px] font-medium text-destructive" role="alert">{(remove.error ?? logins.error)?.message}</p>
      ) : null}
      <div className="mt-2">
        <ConnectorFold summary="Adding another user, choosing an account">
          <div className="max-w-[62ch] space-y-2 pb-1 text-[13px] leading-[1.45] text-muted-foreground">
            <p>To add another Cloudflare user, sign out of Cloudflare first or finish the sign-in in a private window.</p>
            <p>A command names another account as <code>&lt;account id&gt;/…</code>. Run <code>@cloudflare:list_accounts:*</code> in
              a Channel to see every account and its id.</p>
          </div>
        </ConnectorFold>
      </div>
    </ConnectorSection>
  );
}
