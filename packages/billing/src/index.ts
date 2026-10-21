/**
 * Space billing: what a deployment charges for, seen from the product core.
 *
 * The core asks one policy whether an account may create another Space, and
 * whether a Space may take another billable member or message, inside the
 * transaction that commits it. This package is the
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
 * (timestamptz), `$10` whether the message is billable, `$13` the author kind
 * (`user`, `agent`, `app` or `system`), `$14` whether the deployment waives the
 * Space's Agent credits (its own operator Space). `accepts` is a predicate over
 * `admission` columns. The core publishes when the message is not billable or
 * `accepts` holds, and returns the `admission` row to `rejection` otherwise.
 * A published billable message's row goes to `notice`, which may ask the core
 * to tell the Channel about the Space's allowance.
 */
export interface MessageAdmission {
  ctes: string;
  accepts: string;
  rejection(row: Record<string, unknown>, input: { now: string }): BillingRejection | null;
  notice?(row: Record<string, unknown>): BillingNotice | null;
}

/**
 * Something the Space should be told after a write was admitted, such as an
 * allowance crossing a threshold. The core posts `body` once per `key` as a
 * system notice in the Channel the write went to.
 */
export interface BillingNotice {
  key: string;
  body: string;
}

/** What each purchased seat and each credit pack is worth in Agent credits. */
export interface CreditAllowance {
  perSeat: number;
  gracePerSeat: number;
  packCredits: number;
}

/** A provider call's public tariff, selected by the server, never a client. */
export type PaidCallKind = "x_post" | "x_post_url" | "x_post_read" | "x_profile_read" | "x_media";

/** Which balances funded a reservation, so settlement can refund them once. */
export interface CreditAllocation {
  periodStart: string;
  included: number;
  pack: number;
  grace: number;
  remaining: number;
}

export interface PaidCallPolicy {
  /** Null means no configured retail tariff: do not call the provider. */
  quote(kind: PaidCallKind, units: number): number | null;
  reserve(transaction: BillingTransaction, input: {
    spaceId: string; now: string; credits: number; creditsWaived: boolean;
  }): Promise<CreditAllocation | BillingRejection>;
  /** Refunds only the supplied allocation; its durable receipt owns idempotency. */
  refund(transaction: BillingTransaction, input: {
    spaceId: string; now: string; allocation: CreditAllocation; credits: number;
  }): Promise<number>;
  notice?(transaction: BillingTransaction, input: { spaceId: string; now: string }): Promise<BillingNotice | null>;
}

/** A durable write other than a Channel message. */
export type DurableWriteKind = "page_revision";

export interface SpaceBillingPolicy {
  /** Distinguishes this policy's prepared statements. */
  readonly id: string;
  /** Whether Spaces have plans; without them the Hub serves no billing routes. */
  readonly metered: boolean;
  /** A paid Space's monthly Agent credits, when the policy charges them. */
  readonly credits?: CreditAllowance;
  readonly paidCalls?: PaidCallPolicy;
  /**
   * Called in the transaction that creates a Space, before anything is
   * written; a rejection refuses it. `personalSpaceIds` are the Spaces the
   * product makes for the owner on its own (whether or not they exist), which
   * an allowance of Spaces per account may leave out.
   */
  spaceCreation(
    transaction: BillingTransaction,
    input: { ownerUserId: string; now: string; personalSpaceIds: readonly string[] },
  ): Promise<BillingRejection | null>;
  /** Called in the transaction that creates a Space, once it is written. */
  spaceCreated(transaction: BillingTransaction, input: { spaceId: string; now: string }): Promise<void>;
  /** Called before a Space is marked deleted; a rejection blocks deletion. */
  spaceDeletion(
    transaction: BillingTransaction,
    input: { spaceId: string; now: string; intent?: "account-deletion" },
  ): Promise<BillingRejection | null>;
  /** Called before someone becomes a billable member (owner, admin or member). */
  seatAdmission(
    transaction: BillingTransaction,
    input: { spaceId: string; now: string },
  ): Promise<BillingRejection | null>;
  readonly message: MessageAdmission;
  /**
   * Called in the transaction that commits a durable write other than a
   * message, by a person or an Agent, before it is written; a rejection
   * refuses it. `creditsWaived`, as for messages, is the deployment's own
   * operator Space.
   */
  durableWrite(
    transaction: BillingTransaction,
    input: { spaceId: string; now: string; kind: DurableWriteKind; author: "person" | "agent"; creditsWaived?: boolean },
  ): Promise<BillingRejection | null>;
}

/** Nothing is metered: every Space, member and message is admitted. */
export const spaceBilling: SpaceBillingPolicy = {
  id: "unmetered",
  metered: false,
  async spaceCreation() { return null; },
  async spaceCreated() {},
  async spaceDeletion() { return null; },
  async seatAdmission() { return null; },
  async durableWrite() { return null; },
  message: {
    ctes: "admission AS MATERIALIZED (SELECT TRUE AS unmetered)",
    accepts: "TRUE",
    rejection: () => null,
  },
};
