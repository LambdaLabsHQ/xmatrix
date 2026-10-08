import { xmatrixApiRequest } from "@/lib/query/api-client";
import type { WorktreeAction, WorktreeActionStatus } from "@xmatrix/protocol";

const ACTIONS = "/api/xmatrix/machine-daemons/worktree-actions";
export function queueWorktreeAction(token: string, machineId: string, action: WorktreeAction,
  paths?: string[], signal?: AbortSignal) {
  return xmatrixApiRequest<{ controlId: string; status: "queued" }>({ url: ACTIONS, token,
    method: "POST", body: { machineId, action, ...(paths ? { paths } : {}) }, signal });
}
export function readWorktreeAction(token: string, controlId: string, signal?: AbortSignal) {
  return xmatrixApiRequest<WorktreeActionStatus>({ url: `${ACTIONS}/${encodeURIComponent(controlId)}`, token, signal });
}
export async function readLatestWorktreeListing(token: string, machineId: string, signal?: AbortSignal) {
  const data = await xmatrixApiRequest<{ listing?: WorktreeActionStatus | null }>({
    url: `${ACTIONS}?machineId=${encodeURIComponent(machineId)}`, token, signal });
  return data.listing ?? null;
}
