import type { SerializedWorkspace } from "@xmatrix/protocol";
import { repoSummonReference } from "@xmatrix/protocol";

/* The reference a repo summon inserts after `:new:`. Normalization lives with
   the shared mention grammar so the composer can only ever insert a reference
   the Hub also accepts. */
export function repoReferenceForWorkspace(workspace: SerializedWorkspace): string | undefined {
  const remote = workspace.gitRemote?.trim();
  if (!remote) return undefined;
  return repoSummonReference(remote);
}

export function compactWorkspacePathTail(path: string): string {
  const parts = workspacePathParts(path);
  if (parts.length === 0) return path.trim();
  if (parts.length === 1) return parts[0];
  return parts.slice(-2).join("/");
}

function workspacePathParts(path: string): string[] {
  const normalized = path
    .trim()
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  return normalized.split("/").filter(Boolean);
}
