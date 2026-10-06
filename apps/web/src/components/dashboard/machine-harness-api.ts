import { xmatrixApiRequest } from "@/lib/query/api-client";
import type { HarnessAction, HarnessActionStatus } from "@xmatrix/protocol";

const ACTIONS = "/api/xmatrix/machine-daemons/harness-actions";
export function queueHarnessAction(token: string, machineId: string, hostId: string | undefined,
  presetId: string, action: HarnessAction, signal?: AbortSignal, code?: string) {
  return xmatrixApiRequest<{ controlId: string; status: "queued" }>({ url: ACTIONS, token,
    method: "POST", body: { machineId, hostId, presetId, action, ...(code ? { code } : {}) }, signal });
}
export function readHarnessAction(token: string, controlId: string, signal?: AbortSignal) {
  return xmatrixApiRequest<HarnessActionStatus>({ url: `${ACTIONS}/${encodeURIComponent(controlId)}`, token, signal });
}
export function refreshHarnessInventory(token: string, machineId: string, hostId?: string, signal?: AbortSignal) {
  return queueHarnessAction(token, machineId, hostId, "custom", "refresh", signal);
}
