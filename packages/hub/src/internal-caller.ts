import type { AuthUser } from "./auth";

/**
 * A request the Hub makes to its own routes on a person's behalf, such as an
 * MCP tool call that sends a message: the route runs exactly as if that
 * person had called it. The caller is named by a single-use key in a header
 * and a secret only this isolate holds, so no request from outside can name
 * one, and no credential is minted for it.
 */

const HEADER = "x-xmatrix-internal-caller";
const ISOLATE_SECRET = crypto.randomUUID();
const callers = new Map<string, AuthUser>();

/** Runs `call` with a header that makes the Hub's routes see `user` as the caller. */
export async function asInternalCaller<T>(user: AuthUser, call: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  const key = crypto.randomUUID();
  callers.set(key, user);
  try {
    return await call({ [HEADER]: `${ISOLATE_SECRET}.${key}` });
  } finally {
    callers.delete(key);
  }
}

/** The person an internal request acts for; undefined for every request from outside. */
export function internalCallerOf(request: Request): AuthUser | undefined {
  const value = request.headers.get(HEADER);
  if (!value) return undefined;
  const [secret, key] = value.split(".");
  return secret === ISOLATE_SECRET && key ? callers.get(key) : undefined;
}
