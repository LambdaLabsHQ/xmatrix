"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import { actionClass } from "@/components/ui/action-tone";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { userErrorMessage } from "@/lib/user-facing-error";

import { ToolDetailSection, ToolSettingRow } from "./tool-split";

export interface SpaceDeletionSummary {
  spaceId: string;
  spaceName: string;
  requestedAt: string;
  purgeAfter: string;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function spaceDeletionsQueryKey(userId: string) {
  return xmatrixQueryKeys.domain({ userId }, "space-deletions");
}

/**
 * Owner-only. Deleting removes every member's access at once; the Space and
 * its history stay restorable for seven days before they are purged.
 */
export function SpaceDangerZone({
  space,
  userId,
  onDeleteSpace,
}: {
  space: { id: string; name: string };
  userId: string;
  onDeleteSpace: (spaceId: string) => Promise<{ purgeAfter: string }>;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmation.trim() === space.name;

  async function submit() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDeleteSpace(space.id);
      await queryClient.invalidateQueries({ queryKey: spaceDeletionsQueryKey(userId) });
    } catch (err) {
      setError(userErrorMessage(err, "Couldn't delete the Space"));
      setBusy(false);
    }
  }

  function close() {
    setOpen(false);
    setConfirmation("");
    setError(null);
  }

  // The last section of the paper, a settings row like its neighbours; red appears only on the
  // action. The confirmation is asked for once the owner sets out to delete.
  return (
    <ToolDetailSection title="Delete this Space">
      <ToolSettingRow
        title={`Delete ${space.name}`}
        description="Everyone loses access at once and running agents stop. You can restore it here for 7 days; after that its channels, messages and files are deleted for good."
        control={!open ? (
          <button type="button" onClick={() => setOpen(true)} className={actionClass({ variant: "danger" })}>
            Delete Space…
          </button>
        ) : null}
        below={open || error ? (
          <>
            {open ? (
              <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                <label className="block min-w-48 flex-1 text-[13px] font-semibold text-muted-foreground">
                  Type <span className="font-bold text-foreground">{space.name}</span> to confirm
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submit();
                      if (event.key === "Escape") close();
                    }}
                    disabled={busy}
                    autoFocus
                    aria-label={`Type ${space.name} to confirm deleting it`}
                    className="mt-1.5 h-9 w-full rounded-md border border-border px-3 text-sm font-normal text-foreground"
                  />
                </label>
                <button type="button" onClick={close} disabled={busy} className={actionClass({ variant: "quiet" })}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!confirmed || busy}
                  className={actionClass({ variant: "danger" })}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  Delete Space
                </button>
              </div>
            ) : null}
            {error ? <p className="mt-2 text-xs font-medium text-destructive">{error}</p> : null}
          </>
        ) : null}
      />
    </ToolDetailSection>
  );
}

/** Spaces this user deleted and can still restore. Renders nothing when there are none. */
export function DeletedSpacesList({
  token,
  userId,
  onRestoreSpace,
}: {
  token?: string;
  userId: string;
  onRestoreSpace: (spaceId: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deletions = useQuery({
    queryKey: spaceDeletionsQueryKey(userId),
    queryFn: ({ signal }) => xmatrixApiRequest<{ deletions?: SpaceDeletionSummary[] }>({
      url: WEB_PROXY_ROUTES.space_deletions, token, signal,
    }).then((payload) => payload.deletions ?? []),
    enabled: Boolean(token),
  });
  const items = deletions.data ?? [];
  if (items.length === 0) return null;

  async function restore(spaceId: string) {
    if (restoringId) return;
    setRestoringId(spaceId);
    setError(null);
    try {
      await onRestoreSpace(spaceId);
      await queryClient.invalidateQueries({ queryKey: spaceDeletionsQueryKey(userId) });
    } catch (err) {
      setError(userErrorMessage(err, "Couldn't restore the Space"));
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <div className="rounded-md border border-border px-4 py-3">
      <p className="text-sm font-black">Deleted Spaces</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Restore a Space before its purge time to bring back its members, channels, and history.
      </p>
      <ul className="mt-3 divide-y divide-border/60">
        {items.map((item) => (
          <li key={item.spaceId} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{item.spaceName || item.spaceId}</p>
              <p className="text-xs text-muted-foreground">Purged after {formatDate(item.purgeAfter)}</p>
            </div>
            <button
              type="button"
              onClick={() => void restore(item.spaceId)}
              disabled={Boolean(restoringId)}
              className={actionClass({ variant: "secondary", size: "sm" })}
            >
              {restoringId === item.spaceId
                ? <Loader2 className="size-3.5 animate-spin" />
                : <RotateCcw className="size-3.5" />}
              Restore
            </button>
          </li>
        ))}
      </ul>
      {error ? <p className="mt-2 text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
