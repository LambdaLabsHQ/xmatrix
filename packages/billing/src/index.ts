/**
 * Space billing: what a deployment charges for, seen from the product core.
 *
 * The core asks one policy whether a Space may take another billable member
 * or message, inside the transaction that commits it. This package is the
 * policy every deployment gets by default: nothing is metered. A deployment
 * that charges supplies its own policy under this module name at build time
 * (see deploy/README.md), so its checkout, prices and allowances never ship
 * with the product.
 */

/** The part of a PostgreSQL transaction a policy may use. */
export interface BillingTransaction {
  query<T extends Record<string, unknown> = Record<string, unknown>>(query: {
    name: string;
    text: string;
    values: readonly unknown[];
    maxRows: number;
  }): Promise<readonly T[]>;
}

/** Why a Space may not do something; the core raises it as its own error. */
export interface BillingRejection {
  code: string;
  status: number;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

/**
 * Message admission runs in the statement that publishes the message, so a
 * metered counter is advanced and checked without holding its row lock across
 * another round trip. `ctes` defines a CTE named `admission` (and any it
 * needs) from the statement's parameters: `$2` Space id, `$6` commit time
 * (timestamptz), `$10` whether the message is billable. `accepts` is a
 * predicate over `admission` columns. The core publishes when the message is
 * not billable or `accepts` holds, and returns the `admission` row to
 * `rejection` otherwise.
 */
export interface MessageAdmission {
  ctes: string;
  accepts: string;
  rejection(row: Record<string, unknown>, input: { now: string }): BillingRejection | null;
}

export interface SpaceBillingPolicy {
  /** Distinguishes this policy's prepared statements. */
  readonly id: string;
  /** Whether Spaces have plans; without them the Hub serves no billing routes. */
  readonly metered: boolean;
  /** Called in the transaction that creates a Space. */
  spaceCreated(transaction: BillingTransaction, input: { spaceId: string; now: string }): Promise<void>;
  /** Called before a Space is marked deleted; a rejection blocks deletion. */
  spaceDeletion(
    transaction: BillingTransaction,
    input: { spaceId: string; now: string },
  ): Promise<BillingRejection | null>;
  /** Called before someone becomes a billable member (owner, admin or member). */
  seatAdmission(
    transaction: BillingTransaction,
    input: { spaceId: string; now: string },
  ): Promise<BillingRejection | null>;
  readonly message: MessageAdmission;
}

/** Nothing is metered: every member and message is admitted. */
export const spaceBilling: SpaceBillingPolicy = {
  id: "unmetered",
  metered: false,
  async spaceCreated() {},
  async spaceDeletion() { return null; },
  async seatAdmission() { return null; },
  message: {
    ctes: "admission AS MATERIALIZED (SELECT TRUE AS unmetered)",
    accepts: "TRUE",
    rejection: () => null,
  },
};
