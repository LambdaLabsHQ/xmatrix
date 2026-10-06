import type { Env } from "./types";

/**
 * The Web and Hub origins of this deployment. They come from the deployment
 * profile (`APP_URL`, `HUB_URL`); a Hub without them fails closed instead of
 * sending people to another deployment's origins.
 */
export function deploymentOrigin(value: string | undefined, label: string): URL {
  const raw = value?.trim().replace(/\/+$/u, "") ?? "";
  if (!raw) throw new Error(`${label} is not configured`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) origin`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash || parsed.origin !== raw
  ) {
    throw new Error(`${label} must be an absolute HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return parsed;
}

/** The Web app origin, e.g. for links in mail and redirects after OAuth. */
export function appOrigin(env: Pick<Env, "APP_URL">): string {
  return deploymentOrigin(env.APP_URL, "APP_URL").origin;
}

/** The Hub origin: Better Auth base URL and the JWT issuer and audience. */
export function hubAuthBaseUrl(env: Pick<Env, "HUB_URL">): string {
  return deploymentOrigin(env.HUB_URL, "HUB_URL").origin;
}
