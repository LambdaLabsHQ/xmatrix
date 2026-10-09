import { DetailedControlError } from "./control-error.js";
import type { DatabaseTransaction } from "./contracts.js";

declare const verified: unique symbol;
export type AccountSpaceClosureAuthorization = { readonly [verified]: true };
const grants = new WeakMap<object, { userId: string; spaceId: string; name: string; expiresAt: number }>();

// Only the account repository issues this after checking the directory's fresh
// Human session. A JSON body, copied object or serialized grant cannot recreate it.
export function issueAccountSpaceClosureAuthorization(userId: string, spaceId: string, name: string): AccountSpaceClosureAuthorization {
  const grant = Object.freeze({}) as AccountSpaceClosureAuthorization;
  grants.set(grant, { userId, spaceId, name, expiresAt: Date.now() + 30_000 });
  return grant;
}

export function assertAccountSpaceClosureAuthorization(grant: AccountSpaceClosureAuthorization,
  userId: string, spaceId: string, name?: string): void {
  const scope = grants.get(grant);
  if (!scope || scope.userId !== userId || scope.spaceId !== spaceId ||
      scope.expiresAt <= Date.now() || (name !== undefined && scope.name !== name)) {
    throw new DetailedControlError("account_space_confirmation", 409,
      "Confirm your identity and the current Space name again before closing it");
  }
}

/** Serializes closure/restore with the identity's shard-local admission fence. */
export async function assertAccountSpaceActionAdmitted(tx: DatabaseTransaction, userId: string): Promise<void> {
  await tx.query({name:"account_space_action_lock_v1",text:"SELECT pg_advisory_xact_lock(hashtextextended('account-deletion:' || $1,0))",values:[userId],maxRows:1});
  const closing=await tx.query({name:"account_space_action_fence_v1",text:"SELECT user_id FROM data.account_deletion_fences WHERE user_id=$1 AND (committed OR expires_at>clock_timestamp()) LIMIT 1",values:[userId],maxRows:1});
  if(closing.length)throw new DetailedControlError("conflict",409,"Closing or deleted accounts cannot close or restore Spaces");
}
