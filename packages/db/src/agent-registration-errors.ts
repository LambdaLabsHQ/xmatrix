import type { DatabaseTransaction } from "./contracts.js";
import { ControlError } from "./control-error.js";

export class RegistrationAccessError extends ControlError {
  override name = "RegistrationAccessError";
  constructor(code: string, status: number) { super(code, status, code, status >= 500); }
}

/** The refusal for a launch route that found no online daemon. When the
 * machine's daemon is known but not online, that is the cause, and the caller
 * can simply wait for it to reconnect; otherwise `fallback` (a missing
 * Workspace, route or capability) stands. `workspaceId` names the registered
 * Workspace required by the route. */
export async function registrationRouteRefusal(tx: DatabaseTransaction, fallback: string,
  route: { ownerUserId: string; machineId: string; hostId?: string | null; workspaceId?: string }): Promise<RegistrationAccessError> {
  if (route.workspaceId !== undefined) {
    const workspace = (await tx.query({ name: "registration_route_refusal_workspace_v2", text: `SELECT
      workspace_id FROM data.workspaces WHERE workspace_id=$1 AND owner_user_id=$2 AND machine_id=$3`,
    values: [route.workspaceId, route.ownerUserId, route.machineId], maxRows: 1 }))[0];
    if (!workspace) return new RegistrationAccessError(fallback, 409);
  }
  const daemons = (await tx.query({ name: "registration_route_refusal_daemon_v2", text: `SELECT
      count(*) FILTER (WHERE status='online') AS online,count(*) AS known FROM data.machine_daemons
    WHERE owner_user_id=$1 AND machine_id=$2`,
  values: [route.ownerUserId, route.machineId], maxRows: 1 }))[0];
  return Number(daemons?.known ?? 0) > 0 && Number(daemons?.online ?? 0) === 0
    ? new RegistrationAccessError("registration_daemon_offline", 409)
    : new RegistrationAccessError(fallback, 409);
}
