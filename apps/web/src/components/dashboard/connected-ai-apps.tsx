"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";

import { actionClass } from "@/components/ui/action-tone";
import { listConnectedOAuthApps, mcpServerUrl, removeConnectedOAuthApp } from "@/lib/auth-client";

const QUERY_KEY = ["auth", "connected-oauth-apps"] as const;

/**
 * Outside AI apps (ChatGPT, Grok, Cursor…) this person let into their xMatrix
 * through the MCP server, and the address to connect another one.
 */
export function ConnectedAiApps() {
  const queryClient = useQueryClient();
  const apps = useQuery({ queryKey: QUERY_KEY, queryFn: listConnectedOAuthApps });
  const remove = useMutation({
    mutationFn: removeConnectedOAuthApp,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  return (
    <div className="flex items-start gap-3" data-testid="connected-ai-apps">
      <Plug className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold text-foreground">AI apps</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Add <code className="break-all">{mcpServerUrl()}</code> as a connector in ChatGPT, Grok or Cursor to use
          your pages and channels there. An app acts as you, with only your access.
        </p>
        {apps.data?.length ? (
          <ul className="mt-2 space-y-1">
            {apps.data.map((app) => (
              <li key={app.consentId} className="flex items-center justify-between gap-3">
                <span className="truncate text-xs text-foreground">{app.name}</span>
                <button type="button" disabled={remove.isPending} onClick={() => remove.mutate(app.consentId)}
                  className={actionClass({ variant: "secondary", size: "sm" })}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {(apps.error ?? remove.error) && (
          <p role="alert" className="mt-1 text-xs font-semibold text-destructive">
            {(apps.error ?? remove.error)!.message}
          </p>
        )}
      </div>
    </div>
  );
}
