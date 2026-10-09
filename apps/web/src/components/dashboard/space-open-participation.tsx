"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { pageApi } from "@/lib/pages/page-client";
import { userErrorMessage } from "@/lib/user-facing-error";

import { ToolSettingRow } from "./tool-split";

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
    <ToolSettingRow
      title="GitHub participants"
      description={<>
        Anyone with a linked GitHub account can join as a participant. They read the project and start
        conversations; what they start arrives as intake.
        {error ? <span className="mt-1 block font-medium text-destructive">{error}</span> : null}
      </>}
      control={<>
        {busy ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        <Switch label="Anyone with a linked GitHub account can join as a participant"
          checked={governance.data?.openParticipation ?? false} disabled={!governance.data || busy}
          onChange={(open) => void toggle(open)} />
      </>}
    />
  );
}
