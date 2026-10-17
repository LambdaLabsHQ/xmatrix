import type { Env } from "./types";
import { githubAdministeredInstallations, listGitHubUserInstallations } from "./app-connectors";
import { appOrigin, hubAuthBaseUrl } from "./deployment-origins";
import { signGitHubAppState, verifyGitHubAppState } from "./index-shared";

/**
 * Connecting GitHub proves, on GitHub, which App installations the person
 * connecting administers: their own account's, or an organization's whose
 * every covered repository they administer. Reaching an installation through
 * one repository is not enough to hand all of it to a Space. It uses the App's
 * own OAuth credentials and the callback URL already registered for them; a
 * state carrying this prefix is ours, any other belongs to Better Auth's
 * account linking. The user token is used once, here, and never stored.
 */
const CONNECT_STATE_PREFIX = "xmgh.";
const CONNECT_PURPOSE = "github-connect";
// v2 grants named every installation the person reached, not those they
// administer; v3 grants did not name the GitHub user recorded as linking them.
const GRANT_PURPOSE = "github-grant:v4";
const CONNECT_TTL_MS = 10 * 60_000;
const GRANT_TTL_MS = 30 * 60_000;

type ConnectEnv = Pick<Env, "GITHUB_APP_CLIENT_ID" | "GITHUB_APP_CLIENT_SECRET" | "HUB_URL" | "APP_URL"
  | "GITHUB_API_BASE_URL" | "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">;

/** How a GitHub connect ended, as the Web's return page reports it. */
export type GitHubConnectOutcome = "connected" | "updated" | "authorized" | "pending" | "failed" | "cancelled";

/**
 * Every GitHub connect returns through the Web's `/connect/github` page, which
 * keeps the outcome and grant for the tab and then opens the Space's Apps
 * view; the app's own address canonicalization never sees them.
 */
export function githubConnectReturnUrl(env: Pick<Env, "APP_URL">, outcome: GitHubConnectOutcome,
  target: { spaceId?: string; grant?: string } = {}): string {
  const url = new URL(`${appOrigin(env)}/connect/github`);
  url.searchParams.set("github", outcome);
  if (target.spaceId) url.searchParams.set("space", target.spaceId);
  if (target.grant) url.searchParams.set("grant", target.grant);
  return url.toString();
}

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

/** What a completed authorization does in the Space, as the GitHub user GitHub named. */
export interface GitHubConnectInstallations {
  /** Link one installation and record this GitHub user as the one who linked it. */
  link(spaceId: string, userId: string, installationId: string, githubUserId: number): Promise<boolean>;
  /** Record this GitHub user for installations the Space already links, so they stay usable. */
  confirm(spaceId: string, userId: string, githubUserId: number, installationIds: string[]): Promise<void>;
}

/**
 * GitHub's return from the authorization page. A fresh installation is
 * linked when the person administers it; otherwise the installations they
 * administer come back as a short-lived signed grant the Space may link from,
 * and those it already links are confirmed as theirs to delegate.
 */
export async function completeGitHubConnectAuthorization(
  env: ConnectEnv,
  request: Request,
  installations: GitHubConnectInstallations,
  principal: { userId: string; authorizeSpace: (spaceId: string, userId: string) => Promise<void> },
): Promise<Response> {
  const url = new URL(request.url);
  const redirect = (target: string) => Response.redirect(target, 302);
  const { clientSecret } = credentials(env);
  const state = url.searchParams.get("state") || "";
  const payload = await verified(state.slice(CONNECT_STATE_PREFIX.length), clientSecret, CONNECT_PURPOSE);
  const spaceId = typeof payload?.spaceId === "string" ? payload.spaceId : "";
  const userId = typeof payload?.userId === "string" ? payload.userId : "";
  if (!spaceId || !userId) return redirect(githubConnectReturnUrl(env, "failed"));
  const apps = (outcome: GitHubConnectOutcome, grant?: string) =>
    redirect(githubConnectReturnUrl(env, outcome, { spaceId, grant }));
  if (principal.userId !== userId) return apps("failed");
  try { await principal.authorizeSpace(spaceId, userId); } catch { return apps("failed"); }
  if (url.searchParams.get("error")) return apps("cancelled");
  const code = url.searchParams.get("code");
  const token = code ? await exchangeCode(env, code).catch(() => undefined) : undefined;
  if (!token) return apps("failed");
  const installationId = typeof payload?.installationId === "string" ? payload.installationId : "";
  const reachable = (await listGitHubUserInstallations(env, token).catch(() => undefined))
    ?.filter((account) => !installationId || account.installationId === installationId);
  const administered = reachable && await githubAdministeredInstallations(env, token, reachable).catch(() => undefined);
  if (!administered) return apps("failed");

  const { githubUserId, installationIds } = administered;
  if (installationId) {
    // installation_id arrived unsigned from GitHub's setup redirect: only an
    // installation this person's GitHub account administers is linked.
    if (!installationIds.includes(installationId) ||
        !await installations.link(spaceId, userId, installationId, githubUserId)) return apps("failed");
    return apps(payload?.setupAction === "update" ? "updated" : "connected");
  }
  try { await installations.confirm(spaceId, userId, githubUserId, installationIds); } catch { return apps("failed"); }
  const grant = await signGitHubAppState({
    purpose: GRANT_PURPOSE, spaceId, userId, githubUserId, installationIds,
    expiresAt: Date.now() + GRANT_TTL_MS,
  }, clientSecret);
  return apps("authorized", grant);
}

/** The anonymous provider redirect only hands state/code to the signed-in app. */
export async function handoffGitHubConnectAuthorization(env: ConnectEnv, request: Request): Promise<Response> {
  const url = new URL(request.url), state = url.searchParams.get("state") ?? "";
  const payload = isGitHubConnectState(state) && state.length <= 4096
    ? await verified(state.slice(CONNECT_STATE_PREFIX.length), credentials(env).clientSecret, CONNECT_PURPOSE) : undefined;
  if (!payload || typeof payload.spaceId !== "string" || typeof payload.userId !== "string") {
    return Response.redirect(githubConnectReturnUrl(env, "failed"), 302);
  }
  if (url.searchParams.has("error")) return Response.redirect(githubConnectReturnUrl(env, "cancelled"), 302);
  const code = url.searchParams.get("code") ?? "";
  if (!code || code.length > 2048) return Response.redirect(githubConnectReturnUrl(env, "failed"), 302);
  const target = new URL("/connect/oauth", appOrigin(env));
  target.searchParams.set("state", state);
  target.searchParams.set("code", code);
  return Response.redirect(target.toString(), 302);
}

/**
 * A grant from this Space's own authorization: the installations it lets this
 * person link, and the GitHub user GitHub named, who is recorded as linking them.
 */
export async function githubGrant(env: ConnectEnv, grant: string | undefined, input: {
  spaceId: string;
  userId: string;
}): Promise<{ installationIds: string[]; githubUserId: number } | undefined> {
  if (!grant) return undefined;
  const payload = await verified(grant, credentials(env).clientSecret, GRANT_PURPOSE);
  if (!payload || payload.spaceId !== input.spaceId || payload.userId !== input.userId ||
      !Array.isArray(payload.installationIds) || !Number.isSafeInteger(payload.githubUserId) ||
      Number(payload.githubUserId) < 1) return undefined;
  return { installationIds: payload.installationIds.filter((id): id is string => typeof id === "string"),
    githubUserId: Number(payload.githubUserId) };
}

/** The installations a grant from this Space's own authorization lets this person link. */
export async function githubGrantInstallationIds(env: ConnectEnv, grant: string | undefined, input: {
  spaceId: string;
  userId: string;
}): Promise<string[] | undefined> {
  return (await githubGrant(env, grant, input))?.installationIds;
}
