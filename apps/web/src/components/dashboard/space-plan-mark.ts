import { XMatrixApiError } from "../../lib/query/api-client";

/** The Space plan mark.
 *
 * A Space's plan is not part of its Core record — `SerializedSpace` carries
 * identity and membership only — so the mark is derived from a billing read
 * rather than from the Space the shell already holds. Deriving it here keeps
 * the rule in one place: the badge, the billing page and any later surface all
 * answer "what plan is this Space on, and is that plan still spending?" the
 * same way.
 */

export type SpacePlan = "free" | "pro";

/** `ending` still spends but stops at a known date; `blocked` cannot spend now.
 * The distinction is the whole point of the mark: both are "not healthy", and
 * only one of them explains why the Space has stopped sending. */
export type SpacePlanMarkState = "active" | "ending" | "blocked";

/** The subset of the billing summary the mark depends on. The endpoint returns
 * more (seats, management rights); a narrower type keeps unrelated billing
 * changes from rippling into the shell. */
export interface SpacePlanBilling {
  plan: SpacePlan;
  subscription?: {
    status?: string;
    cancelAtPeriodEnd?: boolean;
    access?: "full" | "read_only";
  } | null;
  /** Present on every summary, including Pro's — the lifetime Free allowance is
   * counted whatever the plan, so it only describes a Space that is on Free. */
  freeUsage?: { acceptedMessages?: number; limit?: number; remaining?: number } | null;
}

export interface SpacePlanMark {
  plan: SpacePlan;
  label: "Pro" | "Free";
  state: SpacePlanMarkState;
  /** Hover text: the mark is a status, so it must say *which* status. */
  title: string;
}

/** A deployment that meters nothing serves no Space billing: its reads 404. */
export function spacePlansAbsent(error: unknown): boolean {
  return error instanceof XMatrixApiError && error.status === 404;
}

/** Returns null only when the plan is genuinely unknown — an unread or
 * unreadable billing summary. An unknown plan must not render as Free: the
 * mark would be asserting an entitlement it has not read. */
export function spacePlanMark(
  billing: SpacePlanBilling | null | undefined,
): SpacePlanMark | null {
  if (billing?.plan === "pro") return proMark(billing);
  if (billing?.plan === "free") return freeMark(billing);
  return null;
}

function proMark(billing: SpacePlanBilling): SpacePlanMark {
  const subscription = billing.subscription ?? null;

  // Past due is shown, not hidden: the entitlement is still Pro, but the Space
  // is read-only until payment resolves, and the mark is where someone looking
  // at "why can I not send" would look first.
  if (subscription?.access === "read_only") {
    return {
      plan: "pro",
      label: "Pro",
      state: "blocked",
      title: "Pro — payment past due, this Space is read-only until it is resolved",
    };
  }

  if (subscription?.cancelAtPeriodEnd === true) {
    return {
      plan: "pro",
      label: "Pro",
      state: "ending",
      title: "Pro — cancels at the end of the current period",
    };
  }

  return { plan: "pro", label: "Pro", state: "active", title: "This Space is on Pro" };
}

function freeMark(billing: SpacePlanBilling): SpacePlanMark {
  const remaining = countOrNull(billing.freeUsage?.remaining);
  const limit = countOrNull(billing.freeUsage?.limit);

  // The Free allowance is a lifetime cap, not a window that resets, so running
  // it out is a terminal state for the Space rather than a bad month.
  if (remaining === 0) {
    return {
      plan: "free",
      label: "Free",
      state: "blocked",
      title: limit === null
        ? "Free — the message allowance is used up, this Space cannot send until it upgrades"
        : `Free — all ${limit} messages used, this Space cannot send until it upgrades`,
    };
  }

  return {
    plan: "free",
    label: "Free",
    state: "active",
    title: remaining === null || limit === null
      ? "This Space is on Free"
      : `Free — ${remaining} of ${limit} messages left`,
  };
}

/** The counter arrives over the wire, so a missing or malformed one must read
 * as "not known" rather than as zero remaining, which would blame the Space
 * for a limit it has not hit. */
function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
