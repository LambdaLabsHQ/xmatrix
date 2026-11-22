import { platformAdminEmails } from "./admin-platform-access";
import type { Env } from "./types";

/** The operator's own domains; an address there is never a customer. */
const INTERNAL_DOMAINS = new Set(["xmatrix.sh", "madebyrobot.net", "madebyrobot.llc"]);

/**
 * Whether an address belongs to the operator rather than a customer: an
 * internal domain, a platform admin, or a plus address (how QA accounts are
 * made). Campaigns skip these and grants refuse them, so neither inflates
 * customer numbers. A customer who signs up with a plus address is skipped
 * too; that is the safer mistake.
 */
export function internalAddress(env: Pick<Env, "PLATFORM_ADMIN_EMAILS">, email: string | undefined): boolean {
  const address = email?.trim().toLowerCase() ?? "";
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const local = address.slice(0, at), domain = address.slice(at + 1);
  return INTERNAL_DOMAINS.has(domain) || local.includes("+") || platformAdminEmails(env).includes(address);
}
