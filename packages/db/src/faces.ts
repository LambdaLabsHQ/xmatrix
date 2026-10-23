import type { QueryResultRow } from "pg";
import { agentFaceUrl, type FacesRead } from "@xmatrix/protocol";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { ControlError } from "./control-error.js";
import { inActiveSpace } from "./page-control.js";
import { spaceMemberRole } from "./space-members.js";

/**
 * Faces read by id (protocol faces.ts). A person's face is their account's picture, `control.auth_users.image`,
 * and nothing else: the copies a member row, a message or a session token carry are not read for it. An Agent
 * Instance's face is its harness's mark.
 */
export class FaceControlError extends ControlError {
  override name = "FaceControlError";
  constructor(code: string, status: number, message = code) {
    super(code, status, message);
  }
}

/** Each id asked for, with its account's picture among `accounts`, or none. */
export function userFacesOf(userIds: readonly string[], accounts: ReadonlyArray<{ id: string; image: string | null }>):
  FacesRead["users"] {
  const images = new Map(accounts.map((account) => [account.id, account.image || null]));
  return userIds.map((id) => ({ id, imageUrl: images.get(id) ?? null }));
}

/** Each person's picture, in the Auth authority's transaction; null for an id that names no account. */
export async function readUserFaces(tx: DatabaseTransaction, userIds: readonly string[]): Promise<FacesRead["users"]> {
  if (userIds.length === 0) return [];
  return userFacesOf(userIds, await tx.query<QueryResultRow & { id: string; image: string | null }>({
    name: "faces_users_v1",
    text: "SELECT id, image FROM control.auth_users WHERE id = ANY($1::text[])",
    values: [[...userIds]], maxRows: userIds.length,
  }));
}

/**
 * Each Agent Instance's face, read in its Space by one of the Space's members: the mark of the harness its Run
 * was registered with. An Instance of another Space reads as having none.
 */
export async function readAgentFaces(database: AuthorityDatabase, input: { requestId: string; spaceId: string;
  userId: string; instanceIds: readonly string[] }): Promise<FacesRead["agents"]> {
  const { requestId, spaceId, userId, instanceIds } = input;
  return inActiveSpace(database, { requestId, operation: "faces.agents", spaceId }, FaceControlError, async (tx) => {
    if (await spaceMemberRole(tx, "faces_member_v1", spaceId, userId) === null) {
      throw new FaceControlError("space_not_found", 404);
    }
    if (instanceIds.length === 0) return [];
    const rows = await tx.query<QueryResultRow & { instance_id: string; harness: string }>({
      name: "faces_agents_v1",
      text: `SELECT instance.instance_id, binding.harness
        FROM data.instances instance
        JOIN data.run_agent_registrations binding ON binding.run_id = instance.run_id
        WHERE binding.space_id = $1 AND instance.instance_id = ANY($2::text[])`,
      values: [spaceId, [...instanceIds]], maxRows: instanceIds.length,
    });
    const harnesses = new Map(rows.map((row) => [row.instance_id, row.harness]));
    return instanceIds.map((id) => ({ id, imageUrl: agentFaceUrl(harnesses.get(id)) ?? null }));
  });
}
