"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { pageApi } from "@/lib/pages/page-client";

/**
 * Joining an open project (docs/design/open-project-governance.md §1): signed
 * in with a linked GitHub account, you take part as a participant; what you
 * start goes to the project's intake.
 */
export function SpaceJoinClient({ spaceId }: { spaceId: string }) {
  const router = useRouter();
  const { loading, session } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const here = `/spaces/join/${encodeURIComponent(spaceId)}`;

  const join = async () => {
    if (!session?.access_token) {
      router.push(`/login?next=${encodeURIComponent(here)}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pageApi.participate(spaceId, session.access_token);
      router.push(`/app/${encodeURIComponent(spaceId)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join this project");
      setBusy(false);
    }
  };

  return (
    <main className="site-page flex min-h-screen items-center justify-center px-4 py-10" data-testid="space-join">
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-background p-6 shadow-sm">
        <h1 className="text-2xl font-black">Take part in this project</h1>
        <p className="text-sm text-muted-foreground">
          You join as a participant. Conversations you start go to the project&apos;s intake, where its Agents
          bring them to the right place. Your merged pull requests make you a contributor.
        </p>
        <Button className="w-full" disabled={loading || busy} onClick={() => void join()}>
          {busy && <Loader2 className="size-4 animate-spin" />} Join
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}{" "}
            {/github/iu.test(error) && <Link className="underline" href="/app?view=profile">Open your profile</Link>}
          </p>
        )}
      </div>
    </main>
  );
}
