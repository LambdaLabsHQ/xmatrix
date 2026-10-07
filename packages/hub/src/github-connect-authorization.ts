import type { Env } from "./types";
import { listGitHubUserInstallations } from "./app-connectors";
import { appOrigin, hubAuthBaseUrl } from "./deployment-origins";
import { signGitHubAppState, verifyGitHubAppState } from "./index-shared";

/**
 * Connecting GitHub proves, on GitHub, which App installations the person
 * connecting can reach. It uses the App's own OAuth credentials and the
 * callback URL already registered for them; a state carrying this prefix is
 * ours, any other belongs to Better Auth's account linking. The user token is
 * used once, here, and never stored.
 */
const CONNECT_STATE_PREFIX = "xmgh.";
const CONNECT_PURPOSE = "github-connect";
const GRANT_PURPOSE = "github-grant";
const CONNECT_TTL_MS = 10 * 60_000;
const GRANT_TTL_MS = 30 * 60_000;

type ConnectEnv = Pick<Env, "GITHUB_APP_CLIENT_ID" | "GITHUB_APP_CLIENT_SECRET" | "HUB_URL" | "APP_URL"
  | "GITHUB_API_BASE_URL" | "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">;

/** The connection lands back on the Space's Apps view with this outcome. */
export type GitHubConnectOutcome = "connected" | "updated" | "authorized" | "failed" | "cancelled";

function credentials(env: ConnectEnv): { clientId: string; clientSecret: string } {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("github_connect_not_configured");
  return { clientId, clientSecret };
}

function callbackUrl(env: ConnectEnv): string {
  return `${hubAuthBaseUrl(env)}/api/auth/callback/github`;
}

export function isGitHubConnectState(state: string | undefined | null): boolean {
  return typeof state === "string" && state.startsWith(CONNECT_STATE_PREFIX);
}

/**
 * GitHub's authorization page for one Space. With `installation`, the App was
 * just installed or updated there and only that installation is linked.
 */
export async function githubConnectAuthorizeUrl(env: ConnectEnv, input: {
  spaceId: string;
  userId: string;
  installation?: { id: string; setupAction: "install" | "update" };
}): Promise<string> {
  const { clientId, clientSecret } = credentials(env);
  const state = await signGitHubAppState({
    purpose: CONNECT_PURPOSE,
    spaceId: input.spaceId,
    userId: input.userId,
    nonce: crypto.randomUUID(),
    expiresAt: Date.now() + CONNECT_TTL_MS,
    ...(input.installation
      ? { installationId: input.installation.id, setupAction: input.installation.setupAction }
      : {}),
  }, clientSecret);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callbackUrl(env));
  url.searchParams.set("state", `${CONNECT_STATE_PREFIX}${state}`);
  return url.toString();
}

async function verified(state: string, secret: string, purpose: string): Promise<Record<string, unknown> | undefined> {
  const payload = await verifyGitHubAppState(state, secret).catch(() => undefined);
  return payload?.purpose === purpose ? payload : undefined;
}

async function exchangeCode(env: ConnectEnv, code: string): Promise<string | undefined> {
  const { clientId, clientSecret } = credentials(env);
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "xmatrix-app-connector" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl(env) }),
  });
  if (!response.ok) return undefined;
  const payload = await response.json().catch(() => ({})) as { access_token?: unknown };
  return typeof payload.access_token === "string" && payload.access_token ? payload.access_token : undefined;
}

/**
 * GitHub's return from the authorization page. A fresh installation is
 * linked when the person can reach it; otherwise the installations they can
 * reach come back as a short-lived signed grant the Space may link from.
 */
export async function completeGitHubConnectAuthorization(
  env: ConnectEnv,
  request: Request,
  link: (spaceId: string, userId: string, installationId: string) => Promise<boolean>,
): Promise<Response> {
  const url = new URL(request.url);
  const redirect = (target: string) => Response.redirect(target, 302);
  const { clientSecret } = credentials(env);
  const state = url.searchParams.get("state") || "";
  const payload = await verified(state.slice(CONNECT_STATE_PREFIX.length), clientSecret, CONNECT_PURPOSE);
  const spaceId = typeof payload?.spaceId === "string" ? payload.spaceId : "";
  const userId = typeof payload?.userId === "string" ? payload.userId : "";
  if (!spaceId || !userId) return redirect(`${appOrigin(env)}/app?github=failed`);
  const apps = (outcome: GitHubConnectOutcome, grant?: string) => {
    const target = new URL(`${appOrigin(env)}/app/${encodeURIComponent(spaceId)}/apps`);
    target.searchParams.set("github", outcome);
    if (grant) target.searchParams.set("githubGrant", grant);
    return redirect(target.toString());
  };
  if (url.searchParams.get("error")) return apps("cancelled");
  const code = url.searchParams.get("code");
  const token = code ? await exchangeCode(env, code).catch(() => undefined) : undefined;
  if (!token) return apps("failed");
  const reachable = (await listGitHubUserInstallations(env, token).catch(() => undefined))
    ?.map((account) => account.installationId);
  if (!reachable) return apps("failed");

  const installationId = typeof payload?.installationId === "string" ? payload.installationId : "";
  if (installationId) {
    // installation_id arrived unsigned from GitHub's setup redirect: only an
    // installation this person's GitHub account reaches is linked.
    if (!reachable.includes(installationId) || !await link(spaceId, userId, installationId)) return apps("failed");
    return apps(payload?.setupAction === "update" ? "updated" : "connected");
  }
  const grant = await signGitHubAppState({
    purpose: GRANT_PURPOSE, spaceId, userId, installationIds: reachable.slice(0, 100),
    expiresAt: Date.now() + GRANT_TTL_MS,
  }, clientSecret);
  return apps("authorized", grant);
}

/** The installations a grant from this Space's own authorization lets this person link. */
export async function githubGrantInstallationIds(env: ConnectEnv, grant: string | undefined, input: {
  spaceId: string;
  userId: string;
}): Promise<string[] | undefined> {
  if (!grant) return undefined;
  const payload = await verified(grant, credentials(env).clientSecret, GRANT_PURPOSE);
  if (!payload || payload.spaceId !== input.spaceId || payload.userId !== input.userId) return undefined;
  return Array.isArray(payload.installationIds)
    ? payload.installationIds.filter((id): id is string => typeof id === "string")
    : undefined;
}
