"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { SerializedAgent } from "@xmatrix/protocol";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface StatusPayload {
  status?: string;
  /** Absent where the Hub answers reachability only. */
  onlineAgents?: number;
}

export function ConsoleClient() {
  const { session, user } = useAuth();
  const token = session?.access_token;
  const identity = { userId: user?.id ?? "anonymous" };
  const statusQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain(identity, "console-status"),
    queryFn: ({ signal }) => xmatrixApiRequest<StatusPayload>({
      url: WEB_PROXY_ROUTES.status, signal,
    }),
    staleTime: 5_000,
  });
  const agentsQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain(identity, "console-agents"),
    queryFn: ({ signal }) => xmatrixApiRequest<{ instances: SerializedAgent[] }>({
      url: WEB_PROXY_ROUTES.agent_instances, token, signal,
    }),
    enabled: Boolean(token),
    refetchInterval: () => typeof document !== "undefined" && document.visibilityState === "visible"
      ? 5_000 : false,
  });
  const status = statusQuery.data ?? null;
  const agents = token ? agentsQuery.data?.instances ?? [] : [];
  const statusError = statusQuery.error ? "Unable to load relay status." : null;
  const agentsError = agentsQuery.error ? "Unable to load online agents." : null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="border border-border/70 bg-card/90">
        <CardHeader>
          <Badge variant="outline" className="mb-2">
            Public
          </Badge>
          <CardTitle>Relay Status</CardTitle>
          <CardDescription>Whether the shared xMatrix hub is reachable, even before you sign in.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p>Hub: {status ? "reachable" : statusError ? "unavailable" : "…"}</p>
          {typeof status?.onlineAgents === "number" ? <p>Online agents: {status.onlineAgents}</p> : null}
          {statusError ? (
            <p className="mt-2 text-muted-foreground">{statusError}</p>
          ) : user ? (
            <p className="mt-2 text-muted-foreground">
              Signed in as <span className="text-foreground font-medium">{user.email}</span>
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border border-border/70 bg-card/90">
        <CardHeader>
          <Badge variant="outline" className="mb-2">
            Account
          </Badge>
          <CardTitle>Your Workspace</CardTitle>
          <CardDescription>Inspect the agents attached to your own relay identity.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!token ? (
            <div className="space-y-4">
              <p className="text-muted-foreground">
                Sign in to see your agents, reuse the same account in the CLI, and verify relay state from one place.
              </p>
              <div className="rounded-lg border border-border bg-muted/40 p-3">
                <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  Recommended
                </p>
                <p className="mt-2 font-mono text-xs text-foreground">xmatrix login</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Finish browser sign-in once, then come back here or run `xmatrix whoami`.
                </p>
              </div>
              <Button nativeButton={false} className="w-full" render={<Link href="/login" />}>
                Sign In
              </Button>
            </div>
          ) : agentsError ? (
            <p className="text-muted-foreground">{agentsError}</p>
          ) : agents.length === 0 ? (
            <div className="space-y-4">
              <p className="text-muted-foreground">
                No agents online yet. Add one from the machine that runs it, then summon it in a channel; this view populates automatically.
              </p>
              <div className="rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs text-foreground">
                xmatrix agent add codex --space &lt;space-id&gt;
              </div>
              <Button nativeButton={false} variant="outline" className="w-full" render={<Link href="/docs" />}>
                Open Quick Start
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground">
                  Signed in as <span className="font-medium text-foreground">{user?.email}</span>
                </p>
                <Badge>{agents.length} online</Badge>
              </div>
              {agents.map((agent) => (
                <div key={agent.id} className="rounded-lg border border-border px-3 py-2">
                  <p className="font-medium">{agent.name}</p>
                  <p className="text-muted-foreground">{agent.type}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
