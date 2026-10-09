/** Account deletion is a separate lifecycle from Space deletion and billing. */
export type AccountDeletionState = "preparing" | "blocked" | "committed" | "completed";
/** From commit on, the identity is gone for good: no token, session or late event revives it. */
export const ACCOUNT_REVOKED_STATES: readonly AccountDeletionState[] = ["committed", "completed"];
export const isAccountRevoked = (state: AccountDeletionState): boolean => ACCOUNT_REVOKED_STATES.includes(state);
export interface AccountDeletionBlocker {
  kind: "owned_space" | "membership" | "subscription" | "active_execution" | "capacity";
  spaceId?: string;
  name?: string;
}
export interface AccountDeletionReceipt {
  requestId: string;
  receipt: string;
}
