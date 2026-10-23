"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type SpaceMember } from "@xmatrix/protocol";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { Button } from "@/components/ui/button";
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
    <div className="space-y-3" data-testid="cloudflare-logins">
      <p className="text-xs leading-5 text-muted-foreground">
        Add a login for each Cloudflare user whose accounts this Space works with. To add another user, sign out of
        Cloudflare first or finish the sign-in in a private window.
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        Commands use the default account, or name another as <code>&lt;account id&gt;/…</code>.
        Run <code>@cloudflare:list_accounts:*</code> in a Channel to see every account and its id.
      </p>
      {logins.isPending ? <p className="text-xs text-muted-foreground">Loading Cloudflare logins…</p> : null}
      {remove.error || logins.error ? (
        <p className="text-sm font-medium text-destructive" role="alert">{(remove.error ?? logins.error)?.message}</p>
      ) : null}
      <ul className="divide-y divide-border/60 text-sm">
        {(logins.data ?? []).map((login) => (
          <li key={login.id} className="flex flex-wrap items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">{label(login)}</p>
              <p className="text-xs text-muted-foreground">
                Connected by {connectedBy(login.connectedBy)} on {new Date(login.connectedAt).toLocaleDateString()}
              </p>
            </div>
            <Button size="xs" variant="ghost" aria-label={`Remove ${label(login)}`} disabled={busy}
              onClick={() => {
                if (window.confirm(`Remove the Cloudflare login for ${label(login)}? Commands and alerts for its accounts stop working.`)) {
                  remove.mutate(login);
                }
              }}>
              {remove.isPending && remove.variables.id === login.id
                ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <Trash2 />}
              Remove
            </Button>
          </li>
        ))}
        {logins.data?.length === 0 ? <li className="py-2 text-muted-foreground">No Cloudflare login is connected.</li> : null}
      </ul>
      {!canAdd ? <p className="text-xs text-muted-foreground">Cloudflare one-click connect must be configured before logins can be added.</p> : null}
      <Button size="sm" type="button" disabled={busy || !canAdd} onClick={onAdd}>
        {adding ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <Plus />} Add Cloudflare login
      </Button>
    </div>
  );
}
