import type { SerializedAgentInstance, SerializedWorkspace } from "@xmatrix/protocol";
import { repoSummonReference } from "@xmatrix/protocol";
import { workspaceForInstance } from "./agent-workspaces";
import type { StatusChip } from "./workspace-shell-domain-types";

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

/** The admitted Run repository takes precedence over its managed checkout path. */
export function channelAgentInstanceWorkspaceTag(
  instance: SerializedAgentInstance,
  workspaces: SerializedWorkspace[]
): StatusChip | undefined {
  const repository = instance.repository && repoSummonReference(instance.repository);
  if (repository) return { id: "repo", label: "Repository", value: repository };

  const workspace = workspaceForInstance(workspaces, instance);
  const repo = workspace && repoReferenceForWorkspace(workspace);
  if (repo) return { id: "repo", label: "Repository", value: repo };

  const path = workspace
    ? compactWorkspacePathTail(workspace.canonicalCwd)
    : instance.workspaceName?.trim() || (instance.cwd ? compactWorkspacePathTail(instance.cwd) : undefined);
  return path ? { id: "workspace", label: "Workspace", value: path } : undefined;
}
