"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { pageApi } from "@/lib/pages/page-client";
import { userErrorMessage } from "@/lib/user-facing-error";

/**
 * Whether anyone with a linked GitHub account may join the Space as a
 * participant (docs/design/open-project-governance.md §1): who joins is the
 * Space's call, so it sits with its members, for owners and admins.
 */
export function SpaceOpenParticipation({ spaceId, token }: { spaceId: string; token: string }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "space-governance", [spaceId]);
  const governance = useQuery({
    queryKey,
    enabled: Boolean(token),
    queryFn: ({ signal }) => pageApi.governance(spaceId, token, signal),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (openParticipation: boolean) => {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(queryKey, await pageApi.setGovernance(spaceId, token, { openParticipation }));
    } catch (cause) {
      setError(userErrorMessage(cause, "Couldn't change who can join"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3">
      <label className="flex items-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
        <input type="checkbox" className="mt-0.5 size-4 accent-primary"
          checked={governance.data?.openParticipation ?? false} disabled={!governance.data || busy}
          onChange={(event) => void toggle(event.target.checked)} />
        <span className="min-w-0 flex-1">
          <span className="block font-bold">Anyone with a linked GitHub account can join as a participant</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Participants read the project and start conversations; what they start arrives as intake.
          </span>
        </span>
        {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
      </label>
      {error ? <p className="mt-2 text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
