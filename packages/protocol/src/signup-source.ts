/**
 * Where a new account came from: the domain of the site that sent the person
 * to xMatrix and the `?ref=` tag on the link they followed. Kept to answer
 * which channels bring people, so only these two short values exist; never a
 * full URL, a path or anything else about the visit.
 *
 * Nothing is written to the person's device for this. The Web holds the
 * values in page memory and carries them across its own hops in the URL
 * (`xm_src`, `ref`): from xmatrix.page to xmatrix.sh, and through a social
 * sign-in to the new account's first page, which sends them to the Hub once.
 */

/** The query parameter that carries the referring domain between our own hops. */
export const SIGNUP_SOURCE_HOST_PARAM = "xm_src";
/** The link tag a post or page adds, such as `?ref=x`. */
export const SIGNUP_SOURCE_REF_PARAM = "ref";
/** What `host` says when the person arrived with no outside referrer. */
export const SIGNUP_SOURCE_DIRECT = "direct";

/** Our own sites: a hop between them is not where a person came from. */
const OWN_HOSTS = ["xmatrix.sh", "xmatrix.page"];

/** `POST /api/me/signup-source`: recorded once, on a new account, if still empty. */
export interface SignupSource {
  /** The referring site's domain without `www.`, or `direct`. */
  host: string;
  /** The link's `ref` tag, or null. */
  ref: string | null;
}

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const REF_PATTERN = /^[a-z0-9_-]{1,32}$/u;

/** A referring domain as stored, or null when it is not one. */
export function normalizeSignupSourceHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/^www\./u, "");
  if (host === SIGNUP_SOURCE_DIRECT) return host;
  return host.length <= 64 && HOST_PATTERN.test(host) ? host : null;
}

/** A link tag as stored, or null when it is not one. */
export function normalizeSignupSourceRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ref = value.trim().toLowerCase();
  return REF_PATTERN.test(ref) ? ref : null;
}

/** Whether a host is one of our own sites (or a subdomain of one). */
export function isOwnSignupSourceHost(host: string): boolean {
  return OWN_HOSTS.some((own) => host === own || host.endsWith(`.${own}`));
}

/**
 * The source of a visit that starts on `location` having come from `referrer`.
 * A value our own hop carried in the URL wins; then an outside referrer's
 * domain; otherwise the visit is direct. A referrer that is one of our sites,
 * or localhost, names no source of its own.
 */
export function signupSourceOfVisit(location: string, referrer: string): SignupSource {
  let params: URLSearchParams;
  try { params = new URL(location).searchParams; } catch { params = new URLSearchParams(); }
  const ref = normalizeSignupSourceRef(params.get(SIGNUP_SOURCE_REF_PARAM));
  const carried = normalizeSignupSourceHost(params.get(SIGNUP_SOURCE_HOST_PARAM));
  if (carried) return { host: carried, ref };
  let referrerHost: string | null = null;
  try { referrerHost = referrer ? normalizeSignupSourceHost(new URL(referrer).hostname) : null; } catch { /* none */ }
  if (referrerHost && referrerHost !== SIGNUP_SOURCE_DIRECT && !isOwnSignupSourceHost(referrerHost)) {
    return { host: referrerHost, ref };
  }
  return { host: SIGNUP_SOURCE_DIRECT, ref };
}

/** The request body, validated; null when it names no source. */
export function parseSignupSource(value: unknown): SignupSource | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { host?: unknown; ref?: unknown };
  const host = normalizeSignupSourceHost(record.host);
  if (!host) return null;
  return { host, ref: record.ref === null || record.ref === undefined ? null : normalizeSignupSourceRef(record.ref) };
}

/** `url` with the source added, so it survives a hop to another of our pages. */
export function withSignupSource(url: string, source: SignupSource): string {
  let target: URL;
  try { target = new URL(url); } catch { return url; }
  target.searchParams.set(SIGNUP_SOURCE_HOST_PARAM, source.host);
  if (source.ref) target.searchParams.set(SIGNUP_SOURCE_REF_PARAM, source.ref);
  return target.toString();
}
