/**
 * The account calls a desktop or phone app's page makes (two-step
 * verification, linked GitHub, outside apps, sign-out), sent on with the app's
 * own session from its HTTP-only cookie. The page never holds that 30-day
 * token itself. Both the request and the returned facts are allowlisted:
 * Better Auth's session and two-factor responses also contain session tokens.
 */
interface Fields { readonly [key: string]: true | Fields }
const USER: Fields = { id: true, email: true, name: true, image: true, emailVerified: true,
  twoFactorEnabled: true, createdAt: true, updatedAt: true };
const VERIFIED: Fields = { user: USER };
const STATUS: Fields = { status: true, success: true };
const ERRORS: Fields = { code: true, message: true, error: true, error_description: true };

/** One capability names its method and the facts the page consumes, never upstream credentials. */
const CALLS = new Map<string, { method: string; fields: Fields; providerState?: boolean }>([
  ["get-session", { method: "GET", fields: { user: USER, session: {
    id: true, userId: true, expiresAt: true, createdAt: true, updatedAt: true,
  } } }],
  ["two-factor/enable", { method: "POST", fields: { totpURI: true, backupCodes: true } }],
  ["two-factor/verify-totp", { method: "POST", fields: VERIFIED }],
  ["two-factor/verify-backup-code", { method: "POST", fields: VERIFIED }],
  ["two-factor/disable", { method: "POST", fields: STATUS }],
  ["two-factor/generate-backup-codes", { method: "POST", fields: { ...STATUS, backupCodes: true } }],
  ["list-accounts", { method: "GET", fields: { id: true, providerId: true, accountId: true, scopes: true } }],
  ["link-social", { method: "POST", fields: { url: true, redirect: true }, providerState: true }],
  ["unlink-account", { method: "POST", fields: STATUS }],
  ["sign-out", { method: "POST", fields: STATUS }],
  ["oauth2/get-consents", { method: "GET", fields: { id: true, clientId: true, scopes: true } }],
  ["oauth2/delete-consent", { method: "POST", fields: STATUS }],
  ["oauth2/consent", { method: "POST", fields: { url: true, redirect_uri: true, redirect: true } }],
  ["oauth2/public-client", { method: "GET", fields: { client_name: true } }],
]);

/** Pick facts recursively; a newly added upstream field cannot widen what a page receives. */
function project(value: unknown, fields: Fields): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => project(item, fields));
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(fields).filter(([key]) => Object.hasOwn(value, key)).map(([key, shape]) => {
    const item = (value as Record<string, unknown>)[key];
    const scalar = (entry: unknown) => entry === null || ["string", "number", "boolean"].includes(typeof entry);
    return [key, shape === true ? (scalar(item) || (Array.isArray(item) && item.every(scalar)) ? item : null)
      : project(item, shape)];
  }));
}

export function nativeAccountCall(segments: readonly string[], method: string) {
  const path = segments.join("/");
  const call = CALLS.get(path);
  return call?.method === method ? {
    path,
    response: (body: unknown, ok: boolean) => project(body, ok ? call.fields : ERRORS),
    // A Hub session cookie would let page scripts call its raw get-session
    // endpoint directly. Only the provider state needed to link GitHub crosses.
    cookie: (value: string) => call.providerState === true && /^(?:__Secure-)?[a-z0-9-]+\.(?:state|oauth_state)=/u.test(value),
  } : null;
}
