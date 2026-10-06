import type { SerializedWorkspace } from "@xmatrix/protocol";

/** Stable UI key derived from the authoritative natural workspace identity. */
export function workspaceKey(workspace: Pick<SerializedWorkspace, "machineId" | "canonicalCwd">): string {
  return JSON.stringify([workspace.machineId, comparableWorkspacePath(workspace.canonicalCwd)]);
}

/* The registered working directory a live instance is sitting in. An instance
   reports its machine and cwd but never a repository, so the repo name a summon
   would use only exists on the Workspace row this finds. */
export function workspaceForInstance(
  workspaces: SerializedWorkspace[],
  instance: { machineId?: string; cwd?: string; workspace?: { machineId: string; canonicalCwd: string } }
): SerializedWorkspace | undefined {
  const machineId = instance.workspace?.machineId || instance.machineId;
  const cwd = instance.workspace?.canonicalCwd || instance.cwd;
  if (!cwd) return undefined;

  const onPath = workspaces.filter((workspace) => sameWorkspacePath(workspace.canonicalCwd, cwd));
  if (!machineId) return onPath.length === 1 ? onPath[0] : undefined;

  return onPath.find((workspace) => workspacePrimaryMachineId(workspace) === machineId);
}

export function sameWorkspacePath(left: string, right: string): boolean {
  return comparableWorkspacePath(left) === comparableWorkspacePath(right);
}

function workspacePrimaryMachineId(workspace: SerializedWorkspace): string {
  return workspace.machineId;
}

function comparableWorkspacePath(value: string): string {
  const trimmed = value.trim();
  const windowsLike = /^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\\?\\[a-zA-Z]:\\/.test(trimmed);
  const withoutNamespace = trimmed.replace(/^\\\\\?\\/, "");
  return windowsLike
    ? withoutNamespace.replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase()
    : withoutNamespace.replace(/\/+$/g, "");
}
