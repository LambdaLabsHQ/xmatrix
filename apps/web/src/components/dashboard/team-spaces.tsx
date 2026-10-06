"use client";

import { useState } from "react";
import { Loader2, PlusCircle } from "lucide-react";
import type { SerializedSpace } from "@xmatrix/protocol";

import { actionClass } from "@/components/ui/action-tone";
import { DeletedSpacesList, SpaceDangerZone } from "./space-deletion-panel";
import { spaceRoleFor } from "./workspace-shell-recovered";

export function spaceSummary(space: SerializedSpace, userId: string, pendingRequests = 0): string {
  const role = spaceRoleFor(space, userId);
  return [
    `${space.members.length} ${space.members.length === 1 ? "member" : "members"}`,
    role,
    pendingRequests ? `${pendingRequests} waiting to join` : null,
  ].filter(Boolean).join(" · ");
}

/**
 * A Space the viewer is not in right now. Members and invitations are managed
 * from inside a Space, so this offers to open it, and its owner may delete it.
 */
export function TeamOtherSpace({
  space,
  userId,
  onSelectSpace,
  onDeleteSpace,
}: {
  space: SerializedSpace;
  userId: string;
  onSelectSpace: (spaceId: string) => void;
  onDeleteSpace: (spaceId: string) => Promise<{ purgeAfter: string }>;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Open this workspace to manage its members, invitations, and access.
      </p>
      <button
        type="button"
        onClick={() => onSelectSpace(space.id)}
        className={actionClass({ variant: "primary" })}
      >
        Open {space.name}
      </button>
      {spaceRoleFor(space, userId) === "owner" ? (
        <SpaceDangerZone space={space} userId={userId} onDeleteSpace={onDeleteSpace} />
      ) : null}
    </div>
  );
}

/** Create a team Space, or restore one this viewer deleted. */
export function TeamNewSpace({
  token,
  userId,
  creatingSpace,
  onCreateSpace,
  onRestoreSpace,
}: {
  token?: string;
  userId: string;
  creatingSpace: boolean;
  onCreateSpace: (name: string) => Promise<SerializedSpace | undefined>;
  onRestoreSpace: (spaceId: string) => Promise<void>;
}) {
  const [createName, setCreateName] = useState("");

  async function submitCreate() {
    const name = createName.trim();
    if (!name || creatingSpace) return;
    if (await onCreateSpace(name)) setCreateName("");
  }

  return (
    <div className="space-y-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submitCreate();
        }}
      >
        <input
          value={createName}
          onChange={(event) => setCreateName(event.target.value)}
          disabled={creatingSpace}
          placeholder="New workspace name"
          aria-label="New workspace name"
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm"
        />
        <button
          type="submit"
          disabled={creatingSpace || createName.trim().length === 0}
          className={actionClass({ variant: "primary" })}
        >
          {creatingSpace ? <Loader2 className="size-4 animate-spin" /> : <PlusCircle className="size-4" />}
          Create
        </button>
      </form>
      <DeletedSpacesList token={token} userId={userId} onRestoreSpace={onRestoreSpace} />
    </div>
  );
}
