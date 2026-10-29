/** Public account metadata only; grants stay in the Hub's encrypted store. */
export interface StripeAccountView {
  id: string;
  name: string;
  generation: string;
  status: "active" | "reconnect";
  connectedBy: string;
  connectedAt: string;
}
export interface StripeAccountPage { accounts: StripeAccountView[]; after: string | null }
