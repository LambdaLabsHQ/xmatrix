"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ContentSkeleton } from "@/components/dashboard/content-skeleton";
import { ArrowRight, Loader2, Terminal, Users } from "lucide-react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import type { SerializedSpaceInvite } from "@xmatrix/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

type InviteResponse = {
  invite?: SerializedSpaceInvite;
  error?: string;
};

export function SpaceInviteClient({ token }: { token: string }) {
  const router = useRouter();
  const { loading, session, user } = useAuth();
  /* An approval-gated code files a request instead of granting membership. */
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const identity = { userId: user?.id ?? "anonymous" };
  const inviteQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain(identity, "space-invite", [token]),
    queryFn: async ({ signal }) => {
      const payload = await xmatrixApiRequest<InviteResponse>({
        url: WEB_PROXY_ROUTES.space_invite(token), signal,
      });
      if (!payload.invite) throw new Error("Invite link is no longer available.");
      return payload.invite;
    },
  });
  const acceptMutation = useMutation({
    mutationKey: xmatrixQueryKeys.domain(identity, "space-invite-accept", [token]),
    mutationFn: () => xmatrixApiRequest<{ joinRequest?: { status: string } }>({
      url: WEB_PROXY_ROUTES.space_invite_accept(token),
      method: "POST",
      token: session?.access_token,
    }),
  });
  const invite = inviteQuery.data ?? null;
  const loadingInvite = inviteQuery.isPending;
  const accepting = acceptMutation.isPending;
  const error = actionError ?? (inviteQuery.error instanceof Error ? inviteQuery.error.message : null);

  async function acceptInvite() {
    if (!session?.access_token) {
      router.push(`/login?next=${encodeURIComponent(`/spaces/invite/${token}`)}`);
      return;
    }

    setActionError(null);

    try {
      const payload = await acceptMutation.mutateAsync();
      /* This code needs an admin's approval, so no membership exists yet.
         Sending them into the app would land them somewhere they cannot read
         and look like the join silently failed. */
      if (payload.joinRequest) {
        setAwaitingApproval(true);
        return;
      }
      router.push("/app?view=team");
    } catch (nextError) {
      setActionError((nextError as Error).message);
    }
  }

  const loginHref = `/login?next=${encodeURIComponent(`/spaces/invite/${token}`)}`;
  const disabled = loading || loadingInvite || accepting || Boolean(error && !invite);

  return (
    <main className="site-page site-login flex min-h-screen items-center justify-center px-4 py-10">
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, oklch(1 0 0 / 4%) 1px, transparent 0)",
          backgroundSize: "40px 40px",
        }}
      />

      <section className="site-login-panel relative z-10 w-full max-w-sm rounded-xl border bg-card p-6 shadow-lg shadow-black/5">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
          <Terminal className="size-6 text-primary" />
          <span className="text-xl font-bold tracking-tight">xMatrix</span>
        </Link>

        {loadingInvite ? (
          <ContentSkeleton label="Loading invite" lines={4} className="min-h-48 justify-center" />
        ) : invite ? (
          <div className="space-y-6">
            <div className="space-y-3">
              <Badge className="gap-1.5">
                <Users className="size-3.5" />
                Team Space
              </Badge>
              <div>
                <h1 className="text-lg font-semibold tracking-tight">Join {invite.spaceName}</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  You have been invited to join this xMatrix space as {invite.role}.
                </p>
              </div>
              {user?.email ? (
                <p className="text-xs text-muted-foreground">Signed in as {user.email}</p>
              ) : null}
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            {awaitingApproval ? (
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p className="text-sm font-semibold">Waiting for approval</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your request to join {invite.spaceName} has been sent. You will get in once an
                  admin approves it — you can close this page.
                </p>
              </div>
            ) : user ? (
              <Button className="w-full" onClick={acceptInvite} disabled={disabled}>
                {accepting ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Joining
                  </>
                ) : (
                  <>
                    Join space
                    <ArrowRight className="ml-2 size-4" />
                  </>
                )}
              </Button>
            ) : (
              <Button nativeButton={false} className="w-full" render={<Link href={loginHref} />}>
                Sign in to join
                <ArrowRight className="ml-2 size-4" />
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <Badge variant="destructive">Invalid Invite</Badge>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Invite unavailable</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {error || "This invite link is no longer available."}
              </p>
            </div>
            <Button nativeButton={false} variant="ghost" className="w-full" render={<Link href="/" />}>
              Back to xMatrix
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}
