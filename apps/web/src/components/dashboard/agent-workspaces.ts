import { trimEnd, type SerializedWorkspace } from "@xmatrix/protocol";

/** Stable UI key derived from the authoritative natural workspace identity. */
export function workspaceKey(workspace: Pick<SerializedWorkspace, "machineId" | "canonicalCwd">): string {
  return JSON.stringify([workspace.machineId, comparableWorkspacePath(workspace.canonicalCwd)]);
}

/* The registered directory matching an instance, when it has one. Managed
   repository checkouts do not need a registered Workspace row. */
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
    ? trimEnd(withoutNamespace.replace(/\//g, "\\"), "\\").toLowerCase()
    : trimEnd(withoutNamespace, "/");
}
