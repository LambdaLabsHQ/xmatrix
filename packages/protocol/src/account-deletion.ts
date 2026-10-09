/** Account deletion is a separate lifecycle from Space deletion and billing. */
export type AccountDeletionState = "preparing" | "blocked" | "committed" | "completed";
export interface AccountDeletionBlocker {
  kind: "owned_space" | "membership" | "subscription" | "active_execution" | "capacity";
  spaceId?: string;
  name?: string;
}
export interface AccountDeletionReceipt {
  requestId: string;
  receipt: string;
}
