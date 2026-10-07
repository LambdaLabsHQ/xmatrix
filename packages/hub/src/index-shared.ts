import { privateJsonResponse } from "./private-json-response";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { agentBillingReadRoute, BillingReadAccessDenied } from "./billing-read-access";
import { EmailDeliveryConfigurationError, escapeHtml, sendEmail } from "./email-delivery";
import {
  parseRestrictedChannelContentScope,
  AGENT_RUN_PERMISSION_CHANNEL_ATTACHMENTS_WRITE,
  HUB_ROUTES,
  isAutomationIntervalMinutes,
  sha256Hex,
  hmacBytes,
  timingSafeEqual,
  type AgentRunPermission,
  spaceVisibilityScope,
  utf8ByteLength,
} from "@xmatrix/protocol";
import type {
  ChannelAppMention,
} from "@xmatrix/protocol";
import { appOrigin, hubAuthBaseUrl } from "./deployment-origins";
import type { Env } from "./types";
import { relayRuntimeSingleCell } from "./relay-authority-locator";
import {
  LIVE_RUN_PRINCIPAL_FIELDS,
  liveRunIsAdmitted,
  snapshotLiveRunFromProductGateway,
} from "./live-run-admission";
import {
  getAppConnectorProvider,
} from "./app-connectors";
import {
  InvalidAuthTokenError,
  readBearerToken,
  verifyAuthToken,
  type AgentRunPrincipal,
  type AuthUser,
} from "./auth";
import { logAuthMetric } from "./auth-observability";
import {
  machineDaemonCommandPrincipal,
  verifyMachineDaemonCredential,
  type MachineDaemonPrincipal,
} from "./connections/machine-daemon/auth";
import {
  RELAY_R2_BLOB_REF_PATH,
  RELAY_R2_BLOB_REF_RELEASE_PATH,
  RELAY_R2_UPLOAD_INTENT_PATH,
  relayR2UploadPrivateApiErrorResponse,
  type RelayR2UploadPrincipal,
} from "./relay-r2-upload-private-api";
import {
  RELAY_V2_MESSAGE_ATTACHMENT_PRODUCT_MEDIA_PATH,
  relayR2PrivateApiErrorResponse,
} from "./relay-r2-private-api";
import { agentRunUploadScopeId } from "./agent-run-upload-scope";
import { automationDatumFromPayload } from "./relay-authority-schedule-occurrence";
import { base64UrlEncodeValue } from "./relay-v2-primitives";
import { AgentRunDelegationError, requireAgentRunChannelDelegation } from "./agent-run-channel-delegation";
import { reportError } from "@xmatrix/protocol/error-reporting";
import { AgentChannelAccessError, ControlError } from "@xmatrix/db";
import { postgresControlErrorResponse } from "./postgres-authority-http";
import { postgresRetryAfterSeconds, retryablePostgresFailure } from "./postgres-error-classification";
import { machineDaemonCommand } from "./machines";
import { machineRunLifecycleReport } from "./machine-run-lifecycle-report";
import { runtimeRepository } from "./runtime";
import { getChannel, getSpace } from "./spaces";
export { privateResponse } from "./private-response";

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const MAX_INVITE_EMAILS_PER_REQUEST = 100;
export const LOGIN_RATE_LIMIT_WINDOW_MS = 60_000;
export const LOGIN_RATE_LIMIT_PER_EMAIL = 5;
export const LOGIN_RATE_LIMIT_PER_CLIENT = 20;
export const CLIENT_METRIC_RATE_LIMIT = 60;
export const CLIENT_METRIC_RATE_WINDOW_MS = 60_000;
export const CLIENT_METRIC_RATE_MAX_PRINCIPALS = 10_000;
export const AUTH_CORS_ALLOW_METHODS = "GET, POST, OPTIONS";
export const AUTH_CORS_ALLOW_HEADERS = "authorization, content-type";
export const INSTANCE_ABANDON_RESULT_TIMEOUT_MS = 20_000;
export const loginRateLimits = new Map<string, number[]>();
export const clientMetricRateLimits = new Map<string, number[]>();
export class AuthFailure extends Error {
  readonly name = "AuthFailure";
}
export class PermissionFailure extends Error {
  readonly name = "PermissionFailure";
}
/** Reads a stream whole, cancelling it with `cancelReason` once it passes `maxBytes`. */
async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  cancelReason: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel(cancelReason).catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  if (!request.body) return new ArrayBuffer(0);
  const bytes = await readBoundedStream(request.body, maxBytes, "request_too_large");
  return bytes ? bytes.buffer : null;
}
export type InviteEmailRequest = {
  emails?: string[];
  role?: "admin" | "member" | "viewer";
  workspaceName?: string;
  channelCount?: number;
  messageCount?: number;
  historyMode?: "free" | "all";
};
export type AdminInviteEmailRequest = InviteEmailRequest & {
  spaceId?: string;
  source?: string;
  nameIncludes?: string;
};
export type SpaceInviteEmailPayload = {
  inviteUrl: string;
  spaceName: string;
  role: string;
  workspaceName?: string;
  channelCount?: number;
  messageCount?: number;
  historyMode?: "free" | "all";
};
export function hubOrigin(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
/** Connector URLs retain the request origin fallback for deployments without an explicit Hub URL. */
export function connectorHubOrigin(env: Pick<Env, "HUB_URL">, request: Request): string {
  return env.HUB_URL?.trim().replace(/\/+$/u, "") || new URL(request.url).origin;
}
export function betterAuthRouteGroup(path: string, status?: number): string {
  if (path.endsWith("/token")) {
    return status === 401 || status === 403 || status === 429
      ? `auth_token_${status}`
      : "auth_token";
  }
  if (path.includes("/sign-in/social")) return "google_sign_in";
  if (path.includes("/callback/google")) return "google_callback";
  if (path.includes("/email-otp/")) return "better_auth_email_otp";
  if (path.includes("/sign-in/email-otp")) return "better_auth_email_otp";
  if (path.includes("/get-session")) return "better_auth_get_session";
  if (path.includes("/jwks")) return "better_auth_jwks";
  return "better_auth";
}
export async function logBetterAuthHandlerMetrics(path: string, response: Response) {
  const routeGroup = betterAuthRouteGroup(path, response.status);
  await logAuthMetric({
    routeGroup,
    status: response.status,
    outcome: response.ok || response.status < 400 ? "ok" : "error",
    authProvider: "better-auth",
  });

  if (path.includes("/callback/google") && response.status >= 200 && response.status < 400) {
    await logAuthMetric({
      routeGroup: "session_created",
      status: response.status,
      outcome: "google_callback",
      authProvider: "better-auth",
    });
  }

  if (path.includes("/sign-in/email-otp") && response.ok) {
    await logAuthMetric({
      routeGroup: "session_created",
      status: response.status,
      outcome: "better_auth_email_otp",
      authProvider: "better-auth",
    });
  }

  if (path.endsWith("/token") && response.ok) {
    await logAuthMetric({
      routeGroup: "session_reused",
      status: response.status,
      outcome: "auth_token",
      authProvider: "better-auth",
    });
  }
}
export function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
export function authCorsOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  if (!origin) {
    return null;
  }

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return null;
  }

  const allowedOrigins = new Set(
    [appOrigin(env), hubAuthBaseUrl(env)]
      .map((value) => normalizeOrigin(value))
      .filter((value): value is string => Boolean(value))
  );

  return allowedOrigins.has(normalizedOrigin) ? normalizedOrigin : null;
}
export function appendVary(headers: Headers, value: string) {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("vary", value);
    return;
  }

  const values = new Set(
    existing
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  );
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed) values.add(trimmed);
  }
  headers.set("vary", Array.from(values).join(", "));
}
export function setAuthCorsHeaders(headers: Headers, request: Request, env: Env) {
  const origin = authCorsOrigin(request, env);
  if (!origin) {
    return;
  }

  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", AUTH_CORS_ALLOW_METHODS);
  headers.set(
    "access-control-allow-headers",
    request.headers.get("access-control-request-headers") || AUTH_CORS_ALLOW_HEADERS
  );
  headers.set("access-control-max-age", "86400");
  appendVary(headers, "Origin, Access-Control-Request-Headers");
}
export function authCorsPreflight(request: Request, env: Env): Response {
  const headers = new Headers();
  setAuthCorsHeaders(headers, request, env);
  return new Response(null, { status: 204, headers });
}
export function withAuthCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  setAuthCorsHeaders(headers, request, env);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
export function normalizeInviteEmails(emails: unknown): string[] {
  if (!Array.isArray(emails)) {
    return [];
  }

  const unique = new Set<string>();
  for (const value of emails) {
    if (typeof value !== "string") {
      continue;
    }
    const email = value.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      unique.add(email);
    }
  }

  return Array.from(unique);
}
export function formatCount(value: number | undefined, noun: string): string | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const count = Math.max(0, Math.trunc(value as number));
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}
export function buildSpaceInviteEmail(payload: SpaceInviteEmailPayload) {
  const workspaceName = payload.workspaceName?.trim() || payload.spaceName;
  const subject = `${workspaceName} Slack 已迁移到 xMatrix`;
  const channelLine = formatCount(payload.channelCount, "channel");
  const messageLine = formatCount(payload.messageCount, "message");
  const stats = [channelLine, messageLine].filter(Boolean).join(" and ");
  const historyLine =
    payload.historyMode === "all"
      ? "完整历史消息已导入。"
      : payload.historyMode === "free"
        ? "已按 Slack Free 可见范围导入历史消息。"
        : "历史消息已导入。";

  const text = [
    `${workspaceName} Slack 已迁移到 xMatrix。`,
    stats ? `已导入 ${stats}。` : historyLine,
    stats ? historyLine : "",
    "",
    `加入空间：${payload.inviteUrl}`,
    "",
    "如果你没有预期收到这封邮件，可以直接忽略。",
  ]
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n");

  const safeWorkspace = escapeHtml(workspaceName);
  const safeSpaceName = escapeHtml(payload.spaceName);
  const safeInviteUrl = escapeHtml(payload.inviteUrl);
  const safeStats = stats ? escapeHtml(`已导入 ${stats}。`) : "";
  const safeHistoryLine = escapeHtml(historyLine);

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#172033;">
    <div style="display:none;max-height:0;overflow:hidden;">${safeWorkspace} Slack 已迁移到 xMatrix。</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e7ec;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 18px;border-bottom:1px solid #eef0f3;">
                <div style="font-size:15px;font-weight:700;color:#111827;">xMatrix</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#111827;">${safeWorkspace} Slack 已迁移到 xMatrix</h1>
                <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#344054;">你被邀请加入 <strong>${safeSpaceName}</strong> 空间。</p>
                ${safeStats ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#344054;">${safeStats}</p>` : ""}
                <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#344054;">${safeHistoryLine}</p>
                <a href="${safeInviteUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 18px;font-size:15px;font-weight:600;">加入 xMatrix 空间</a>
                <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#667085;">如果按钮打不开，复制这个链接到浏览器：<br><a href="${safeInviteUrl}" style="color:#175cd3;word-break:break-all;">${safeInviteUrl}</a></p>
              </td>
            </tr>
          </table>
          <div style="max-width:560px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#667085;text-align:left;">你收到这封邮件，是因为 ${safeWorkspace} 的 Slack 工作区正在迁移到 xMatrix。</div>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}
export function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

export async function signGitHubAppState(payload: Record<string, unknown>, secret: string): Promise<string> {
  const encodedPayload = base64UrlEncodeValue(JSON.stringify(payload));
  const signature = await hmacBytes("SHA-256", secret, encodedPayload);
  return `${encodedPayload}.${base64UrlEncodeValue(signature)}`;
}

export async function verifyGitHubAppState(state: string, secret: string): Promise<Record<string, unknown> | undefined> {
  const [encodedPayload, signature] = state.split(".");
  if (!encodedPayload || !signature) return undefined;
  const expected = await signGitHubAppState(JSON.parse(base64UrlDecode(encodedPayload)), secret);
  if (!timingSafeEqual(expected, state)) return undefined;
  const payload = JSON.parse(base64UrlDecode(encodedPayload)) as Record<string, unknown>;
  const expiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : 0;
  return expiresAt >= Date.now() ? payload : undefined;
}

export async function sendSpaceInviteEmails(
  env: Env,
  emails: string[],
  payload: SpaceInviteEmailPayload
) {
  if (!env.SEND_EMAIL) {
    throw new EmailDeliveryConfigurationError({
      providerMessage: "Cloudflare Email Sending binding SEND_EMAIL is not configured",
    });
  }

  const message = buildSpaceInviteEmail(payload);
  const sent: string[] = [];
  const failed: Array<{ email: string; error: string }> = [];

  for (const email of emails) {
    try {
      await sendEmail(env, email, message);
      sent.push(email);
    } catch (error) {
      failed.push({
        email,
        error: error instanceof Error ? error.message : "Failed to send email",
      });
    }
  }

  return { sent, failed };
}

export function parseCliRedirectUri(value: string | null): URL | null {
  if (!value) {
    return null;
  }

  try {
    const redirectUrl = new URL(value);
    const host = redirectUrl.hostname.toLowerCase();
    if (redirectUrl.protocol !== "http:" || !LOOPBACK_HOSTS.has(host)) {
      return null;
    }

    return redirectUrl;
  } catch {
    return null;
  }
}

export async function requireAuth(request: Request, env: Env) {
  const token = readBearerToken(request.headers.get("authorization"));
  if (!token) {
    throw new AuthFailure("Missing bearer token");
  }

  try {
    const user = await verifyAuthToken(token, env);
    if (user.agentRun && !agentRunHttpRouteAllowed(request, user.agentRun)) {
      throw new AuthFailure("This API is not available to Agent run principals");
    }
    return user;
  } catch (error) {
    if (error instanceof InvalidAuthTokenError) {
      throw new AuthFailure(error.message);
    }
    throw error;
  }
}

export async function requireMachineDaemonAuth(
  request: Request,
  env: Env
): Promise<MachineDaemonPrincipal> {
  const token = readBearerToken(request.headers.get("authorization"));
  if (!token) throw new AuthFailure("Missing Machine Daemon bearer credential");
  try {
    return await verifyMachineDaemonCredential(token, env);
  } catch {
    throw new AuthFailure("Invalid or expired Machine Daemon credential");
  }
}

export function machineRouteIdentityMatches(
  principal: MachineDaemonPrincipal,
  values: { machineId?: unknown; hostId?: unknown }
): boolean {
  const requestedMachineId = typeof values.machineId === "string" ? values.machineId.trim() : "";
  return (
    (!requestedMachineId || requestedMachineId === principal.machineId)
  );
}

export function appendMachinePrincipal(url: URL, principal: MachineDaemonPrincipal) {
  url.searchParams.set("userId", principal.ownerUserId);
  url.searchParams.set("email", principal.ownerEmail);
  url.searchParams.set("machineId", principal.machineId);
  url.searchParams.set("hostId", principal.hostId);
  if (principal.hostName) url.searchParams.set("hostName", principal.hostName);
}

export function agentRunHttpRouteAllowed(
  request: Request,
  principal: AgentRunPrincipal,
): boolean {
  if (agentBillingReadRoute(request, principal)) return true;
  const path = new URL(request.url).pathname;
  if (principal.runKind === "channel-about-session") {
    const history = /^\/api\/channels\/([^/]+)\/(?:history|metadata-history)$/.exec(path);
    if (request.method === "GET" && history) {
      try {
        return decodeURIComponent(history[1]) === principal.channelId;
      } catch {
        return false;
      }
    }
    if (request.method === "GET" && path === "/api/channels") return true;
    const channel = /^\/api\/channels\/([^/]+)$/.exec(path);
    if (request.method !== "PATCH" || !channel) return false;
    try {
      return decodeURIComponent(channel[1]) === principal.channelId;
    } catch {
      return false;
    }
  }
  if (request.method === "GET" && /^\/api\/channels\/[^/]+\/metadata-history$/.test(path)) return true;
  if (request.method === "POST" && /^\/api\/channels\/[^/]+\/metadata-restore$/.test(path)) return true;
  if (request.method === "GET" && /^\/api\/channels\/[^/]+\/messages\/[^/]+\/decision-evidence$/.test(path)) return true;
  if (request.method === "POST" && /^\/api\/channels\/[^/]+\/join$/.test(path)) return true;
  // The route stops the run itself, and refuses any Channel but its own.
  if (request.method === "POST" && /^\/api\/channels\/[^/]+\/leave$/.test(path)) return true;
  if (request.method === "POST" && path === "/api/invocations/diagnostics") return true;
  // Saves a credential the Run already holds into its Space: the route proves
  // the live Run and refuses an alias the Space already has.
  if (request.method === "POST" && path === HUB_ROUTES.secrets &&
      principal.channelWriteAllowed !== false) return true;
  // Its Space's secrets the Run may read now: every `auto` one, and each
  // `ask` one a Space admin approved for it.
  if (request.method === "POST" && path === HUB_ROUTES.run_secrets &&
      principal.channelWriteAllowed !== false) return true;
  // Ask a Space admin, on a card in its Channel, for a secret it may not read yet.
  if (request.method === "POST" && path === HUB_ROUTES.secret_requests &&
      principal.channelWriteAllowed !== false) return true;
  // Connector actions as MCP tools: each call runs in the Run's own Channel
  // under that Channel's action policy (docs/design/connector-platform.md §3.5).
  if (request.method === "POST" && path === HUB_ROUTES.connectors_mcp &&
      principal.channelWriteAllowed !== false) return true;
  if (request.method === "POST" && path === "/api/ai/jev/evaluate") return true;
  if (request.method === "POST" && /^\/api\/channels\/[^/]+\/messages\/receipt$/u.test(path)) return true;
  // Channel memory authorizes the exact Run in the repository: read where both
  // it and its owner may, propose where it may write, curate only as the creator.
  if ((request.method === "GET" && /^\/api\/channels\/[^/]+\/memory$/u.test(path)) ||
      (["PUT", "DELETE"].includes(request.method) && /^\/api\/channels\/[^/]+\/memory\/[^/]+$/u.test(path))) {
    return true;
  }
  // Cross-Space read grants: ask the owner and poll the answer. Deciding is
  // the owner's alone, so the decision route never admits a Run.
  // Pages authorize the exact Run in the repository, with its owner's page
  // access: Agents read, edit, arrange, restore and publish pages as the owner may.
  if (request.method === "GET" && /^\/api\/spaces\/[^/]+\/pages(?:\/[^/]+(?:\/history|\/awareness|\/changes|\/github-file)?)?$/u.test(path)) return true;
  if (request.method === "POST" && /^\/api\/spaces\/[^/]+\/pages$/u.test(path)) return true;
  if (["PUT", "PATCH", "DELETE"].includes(request.method) && /^\/api\/spaces\/[^/]+\/pages\/[^/]+$/u.test(path)) return true;
  if (request.method === "POST" && /^\/api\/spaces\/[^/]+\/pages\/[^/]+\/(?:revisions\/[^/]+\/promote|purge)$/u.test(path)) return true;
  if (request.method === "PUT" && /^\/api\/spaces\/[^/]+\/pages\/[^/]+\/(?:publication|competition)$/u.test(path)) return true;
  // The Agent reviewing a pull request in its review conversation records the verdict.
  if (request.method === "POST" && /^\/api\/channels\/[^/]+\/pre-review$/u.test(path)) return true;
  // Agents claim the block they work on and release it when done.
  if (["GET", "POST"].includes(request.method) && /^\/api\/spaces\/[^/]+\/pages\/[^/]+\/claims$/u.test(path)) return true;
  if (request.method === "DELETE" && /^\/api\/spaces\/[^/]+\/pages\/[^/]+\/claims\/[^/]+$/u.test(path)) return true;
  // A page's Automations are the page's: a Run that may edit the page manages them as its owner.
  if (/^\/api\/spaces\/[^/]+\/pages\/[^/]+\/automations(?:\/[^/]+(?:\/(?:pause|resume|reference))?)?$/u.test(path)) return true;
  if (["GET", "POST"].includes(request.method) && /^\/api\/spaces\/[^/]+\/page-links$/u.test(path)) return true;
  if (request.method === "PUT" && /^\/api\/spaces\/[^/]+\/page-links\/[^/]+\/resolution$/u.test(path)) return true;
  if (request.method === "GET" && /^\/api\/channels\/[^/]+\/(?:page-space|pages)$/u.test(path)) return true;
  if (request.method === "POST" && /^\/api\/channels\/[^/]+\/page-writeback$/u.test(path)) return true;
  // An owner's or admin's Run reads, drafts and applies the move to pages.
  if (request.method === "GET" && /^\/api\/spaces\/[^/]+\/page-migration$/u.test(path)) return true;
  if (request.method === "PUT" && /^\/api\/spaces\/[^/]+\/page-migration\/draft$/u.test(path)) return true;
  if (request.method === "POST" && /^\/api\/spaces\/[^/]+\/page-migration\/apply$/u.test(path)) return true;
  if (request.method === "POST" && path === HUB_ROUTES.cross_space_read_requests) return true;
  if (request.method === "GET" && /^\/api\/spaces\/[^/]+\/cross-space-read-grants\/[^/]+$/u.test(path)) return true;
  // Human collaboration parity: open threads, create and reorganize Channels,
  // edit and delete its own messages, react, read the launch catalog. Each route
  // proves the exact Run and its owner through requireAgentRunChannelDelegation.
  if (request.method === "POST" && path === HUB_ROUTES.channels) return true;
  if (request.method === "PATCH" && /^\/api\/channels\/[^/]+$/u.test(path)) return true;
  if (["PATCH", "DELETE"].includes(request.method) &&
      /^\/api\/channels\/[^/]+\/messages\/[^/]+$/u.test(path)) return true;
  if (request.method === "POST" && /^\/api\/channels\/[^/]+\/messages\/[^/]+\/reactions$/u.test(path)) return true;
  if (request.method === "GET" && /^\/api\/spaces\/[^/]+\/launch-targets$/u.test(path)) return true;

  if (request.method === "POST") {
    const transfer = /^\/api\/channels\/([^/]+)\/transfer-proposals$/.exec(path);
    if (transfer) {
      try { return decodeURIComponent(transfer[1]) === principal.channelId; } catch { return false; }
    }
  }
  if (request.method === "GET" && path === HUB_ROUTES.spaces) return true;
  // The owner's Machines and their harness actions, read as the owner.
  if (request.method === "GET" && path === HUB_ROUTES.machine_daemons) return true;
  if (request.method === "GET" && /^\/api\/machine-daemons\/harness-actions\/[^/]+$/u.test(path)) return true;
  // Its owner's Workspaces and Agents: read them, register a directory on its
  // own Machine, and add an Agent there (the routes bound each to the Run).
  if (["GET", "POST"].includes(request.method) && path === HUB_ROUTES.workspaces) return true;
  if (request.method === "GET" && /^\/api\/spaces\/[^/]+\/agent-registrations$/u.test(path)) return true;
  if (request.method === "POST" && /^\/api\/spaces\/[^/]+\/agent-registrations\/commands$/u.test(path)) return true;
  if (request.method === "GET" && path === HUB_ROUTES.agent_instances) return true;
  if (request.method === "GET" && path === "/api/channels") return true;
  if (request.method === "GET" && /^\/api\/channels\/[^/]+\/history$/.test(path)) {
    return true;
  }
  const canWriteAttachments = principal.permissions.includes(
    AGENT_RUN_PERMISSION_CHANNEL_ATTACHMENTS_WRITE,
  );
  if (
    canWriteAttachments &&
    request.method === "PUT" &&
    /^\/api\/relay-v2\/private-r2\/uploads\/[^/]+(?:\/staging)?(?:\/scope\/[^/]+)?$/.test(path)
  ) {
    return true;
  }
  if (
    canWriteAttachments &&
    request.method === "POST" &&
    (
      path === RELAY_R2_UPLOAD_INTENT_PATH ||
      path === RELAY_R2_BLOB_REF_PATH ||
      path === RELAY_R2_BLOB_REF_RELEASE_PATH ||
      /^\/api\/relay-v2\/private-r2\/uploads\/[^/]+\/verify(?:\/scope\/[^/]+)?$/.test(path) ||
      /^\/api\/channels\/[^/]+\/messages\/[^/]+\/attachments$/.test(path)
    )
  ) {
    return true;
  }
  if (
    (request.method === "GET" || request.method === "POST") &&
    path === HUB_ROUTES.automations
  ) return true;
  if (
    (request.method === "GET" || request.method === "PATCH" || request.method === "DELETE") &&
    /^\/api\/automations\/[^/]+$/.test(path)
  ) return true;
  if (
    request.method === "POST" &&
    /^\/api\/automations\/[^/]+\/(pause|resume)$/.test(path)
  ) return true;
  if (request.method !== "POST") return false;
  return (
    (principal.channelWriteAllowed && /^\/api\/channels\/[^/]+\/messages$/.test(path)) ||
    path === RELAY_V2_MESSAGE_ATTACHMENT_PRODUCT_MEDIA_PATH
  );
}

export function requireHumanAuth(user: AuthUser): AuthUser {
  if (user.agentRun) throw new AuthFailure("A human session is required");
  return user;
}

export async function requireAgentRunPermission(
  env: Env,
  user: AuthUser,
  permission: AgentRunPermission,
  channelId?: string,
): Promise<AgentRunPrincipal> {
  const principal = user.agentRun;
  if (!principal || !principal.permissions.includes(permission)) {
    throw new PermissionFailure("This Agent Run does not have the required persistent permission");
  }
  if (channelId !== undefined && channelId !== principal.channelId) {
    throw new PermissionFailure("Agent Run permission is limited to its birth channel");
  }

  await requireRunStillAdmitted(env, principal, "Agent Run permission is no longer active");

  return principal;
}

/** Revalidate a run-scoped Agent without introducing a new Profile permission. */
export async function requireLiveAgentRun(
  env: Env,
  user: AuthUser,
): Promise<AgentRunPrincipal> {
  const principal = user.agentRun;
  if (!principal) throw new PermissionFailure("A live Agent Run is required");
  await requireRunStillAdmitted(env, principal, "Agent Run is no longer active");
  return principal;
}

/** The Run behind a token must still be the live execution it was minted for. */
async function requireRunStillAdmitted(
  env: Env,
  principal: AgentRunPrincipal,
  inactive: string,
): Promise<void> {
  const runResult = await runtimeRepository(env).getRun({ requestId: crypto.randomUUID(), runId: principal.runId,
    actorUserId: principal.ownerUserId }).catch(() => undefined);
  if (!runResult) throw new PermissionFailure(inactive);
  const run = runResult.run as Record<string, unknown>;
  if (!liveRunIsAdmitted(
    snapshotLiveRunFromProductGateway(run),
    {
      agentId: principal.agentId,
      channelId: principal.channelId,
      executionKey: principal.executionKey,
      machineId: principal.machineId,
      hostId: principal.hostId,
      instanceId: principal.instanceId,
    },
    LIVE_RUN_PRINCIPAL_FIELDS,
  )) {
    throw new PermissionFailure(inactive);
  }
}

export function automationAgentContext(principal: AgentRunPrincipal): Record<string, unknown> {
  return {
    ownerUserId: principal.ownerUserId,
    runId: principal.runId,
    executionKey: principal.executionKey,
    ...(principal.instanceId ? { instanceId: principal.instanceId } : {}),
    channelId: principal.channelId,
    machineId: principal.machineId,
    hostId: principal.hostId,
  };
}

/**
 * An Agent Run uploads into the visibility scope of any Channel it may write
 * to, as a person would: its own Space's open Channels share the Space scope,
 * and a closed Channel's scope needs the exact Run's access to that Channel.
 * Without a named scope the upload stays in its own Channel's scope.
 */
export async function privateUploadAuthorization(
  env: Env,
  user: AuthUser,
  requestedScopeId?: string,
): Promise<{
  principal: RelayR2UploadPrincipal;
  expectedScopeId?: string;
}> {
  if (!user.agentRun) {
    return { principal: { kind: "user", id: user.id } };
  }
  const principal = await requireAgentRunPermission(
    env,
    user,
    AGENT_RUN_PERMISSION_CHANNEL_ATTACHMENTS_WRITE,
  );
  if (requestedScopeId) {
    const closedChannelId = requestedScopeId.startsWith("channel:") ? requestedScopeId.slice("channel:".length) : "";
    if (requestedScopeId !== spaceVisibilityScope(principal.spaceId) && !closedChannelId) {
      throw new PermissionFailure("Blob visibility scope is invalid");
    }
    try {
      await requireAgentRunChannelDelegation(env, principal, [closedChannelId || undefined]);
    } catch (error) {
      if (error instanceof AgentRunDelegationError || error instanceof AgentChannelAccessError) {
        throw new PermissionFailure("This Agent Run cannot write to that Channel");
      }
      throw error;
    }
    return { principal: { kind: "agent", id: principal.agentId }, expectedScopeId: requestedScopeId };
  }
  const channel = await getChannel(env, { channelId: principal.channelId,
    principal: { kind: "user", id: principal.ownerUserId } })
    .then(({ channel: found }) => found as Record<string, unknown>, () => undefined);
  return {
    principal: { kind: "agent", id: principal.agentId },
    expectedScopeId: agentRunUploadScopeId(principal.channelId, channel),
  };
}

export function actorUserId(user: AuthUser): string {
  return user.agentRun?.ownerUserId || user.id;
}

/** The legacy admin bearer: compared in constant time, and refused outright
 *  when the deployment's token is missing or too short to resist guessing. */
export function requireAdmin(request: Request, env: Env) {
  const expected = env.XMATRIX_ADMIN_TOKEN?.trim() ?? "";
  const token = readBearerToken(request.headers.get("authorization"));
  if (expected.length < ADMIN_TOKEN_MIN_LENGTH || !token || !timingSafeEqual(token, expected)) {
    throw new AuthFailure("Missing or invalid admin token");
  }
}

const ADMIN_TOKEN_MIN_LENGTH = 32;

export class RelayV2MigrationDisabled extends Error {
  readonly name = "RelayV2MigrationDisabled";
}

export class RelayV2ProductAuthorityUnavailable extends Error {
  readonly name = "RelayV2ProductAuthorityUnavailable";
}

export function relayR2PrivateErrorResponse(error: unknown): Response {
  if (error instanceof RelayV2MigrationDisabled) {
    return privateJsonResponse(
      { error: "Relay V2 migration routes are disabled", code: "relay_v2_migration_disabled" },
      404,
    );
  }
  if (error instanceof RelayV2ProductAuthorityUnavailable) {
    return privateJsonResponse(
      { error: error.message, code: "relay_authority_authority_required", retryable: false },
      409,
    );
  }
  const privateApiError = relayR2PrivateApiErrorResponse(error);
  if (privateApiError) return privateApiError;
  const uploadError = relayR2UploadPrivateApiErrorResponse(error);
  if (uploadError) return uploadError;
  const status = requestErrorStatus(error);
  return privateJsonResponse(
    status === 401
      ? { error: (error as Error).message, code: "not_authenticated" }
      : status === 403
        ? { error: (error as Error).message, code: "forbidden" }
      : { error: "Private object service is temporarily unavailable", code: "private_storage_unavailable" },
    status,
  );
}

export function requestErrorStatus(error: unknown): ContentfulStatusCode {
  if (error instanceof ControlError) return error.status as ContentfulStatusCode;
  if (error instanceof AuthFailure) {
    return 401;
  }
  if (error instanceof PermissionFailure || error instanceof BillingReadAccessDenied) {
    return 403;
  }
  if ((error as Error).message === "Invalid or expired auth token") return 401;
  // An outage the driver says a replay can survive; a defect stays a reported 500.
  if (retryablePostgresFailure(error)) {
    console.error("PostgreSQL is unavailable", error);
    return 503;
  }
  // Every failure answered as a 500 is unexpected; it is reported, not only answered.
  reportError(error);
  return 500;
}

/**
 * A route's failure as JSON: a domain rejection under its own status and code,
 * a refused session under its message, a database outage as retryable, and
 * anything else as an internal error whose detail stays in the report.
 */
export function requestErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof ControlError) return postgresControlErrorResponse(error);
  const status = requestErrorStatus(error);
  if (status === 503) {
    return c.json({ error: "PostgreSQL is unavailable", code: "postgres_unavailable", retryable: true }, status,
      { "retry-after": String(postgresRetryAfterSeconds(error)) });
  }
  return status === 500
    ? c.json({ error: "Internal error", code: "internal_error", retryable: false }, status)
    : c.json({ error: (error as Error).message }, status);
}

/** Runs a route's work, answering its failures, thrown or rejected, as `requestErrorResponse`. */
export async function jsonErrors(c: Context, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    return requestErrorResponse(c, error);
  }
}

/** A daemon's identity on a command or report it sends about its own Machine. */
function machineDaemonIdentity(principal: MachineDaemonPrincipal) {
  return {
    ownerUserId: principal.ownerUserId, ownerEmail: principal.ownerEmail,
    machineId: principal.machineId, hostId: principal.hostId, hostName: principal.hostName,
    metadata: {}, capabilities: [], principal: machineDaemonCommandPrincipal(principal),
  };
}

/** A Machine Daemon control command carrying the daemon's identity. */
export function machineDaemonControl(env: Env, principal: MachineDaemonPrincipal, command: Record<string, unknown>) {
  return machineDaemonCommand(env, { ...command, ...machineDaemonIdentity(principal) });
}

/** A Run lifecycle event the daemon reports, carrying its identity, recorded on the Run's Space shard. */
export function machineDaemonLifecycleReport(env: Env, principal: MachineDaemonPrincipal, report: Record<string, unknown>) {
  return machineRunLifecycleReport(env, { ...report, ...machineDaemonIdentity(principal) });
}

/** The Space as the user now sees it, answered as `{ space }`. */
export async function spaceResponse(c: Context<{ Bindings: Env }>, spaceId: string, userId: string): Promise<Response> {
  return c.json({ space: await getSpace(c.env, { spaceId, principal: { kind: "user", id: userId } }) });
}

/**
 * Blob visibility scopes are server-defined (`channel:*`, `space:*` or a
 * restricted Channel content scope); a malformed or caller-invented scope is
 * refused before any blob authority sees it.
 */
export function requireBlobVisibilityScope(visibilityScopeId: string): void {
  try {
    if (parseRestrictedChannelContentScope(visibilityScopeId)) return;
  } catch { throw new PermissionFailure("Blob visibility scope is invalid"); }
  const separator = visibilityScopeId.indexOf(":");
  const kind = separator > 0 ? visibilityScopeId.slice(0, separator) : "";
  const scopeId = separator > 0 ? visibilityScopeId.slice(separator + 1) : "";
  if (!scopeId || scopeId.length > 200 || scopeId !== scopeId.trim() || (kind !== "channel" && kind !== "space")) {
    throw new PermissionFailure("Blob visibility scope is invalid");
  }
}

export async function relayVisibilityScopeIdFromRequest(request: Request): Promise<string> {
  let value: unknown;
  try {
    value = (await request.clone().json() as Record<string, unknown>).visibilityScopeId;
  } catch {
    throw new PermissionFailure("Blob visibility scope is invalid");
  }
  if (typeof value !== "string") throw new PermissionFailure("Blob visibility scope is invalid");
  return value;
}

/**
 * Product-media requests intentionally name only the Channel, message, and
 * attachment. The visibility scope is server authority selected after the
 * attachment binding is read, so it must never become a required client
 * field merely to choose the owning Authority before that read.
 */
export async function relayChannelIdFromRequest(request: Request): Promise<string> {
  let value: unknown;
  try {
    value = (await request.clone().json() as Record<string, unknown>).channelId;
  } catch {
    throw new PermissionFailure("Channel authority route is invalid");
  }
  if (typeof value !== "string" || !value || value.length > 200 || value !== value.trim()) {
    throw new PermissionFailure("Channel authority route is invalid");
  }
  return value;
}

export function getRelayRuntime(env: Env) {
  return relayRuntimeSingleCell(env);
}

export function productCommandId(
  request: Request,
  family: string,
  stableId?: string,
): string {
  const callerKey = request.headers.get("x-xmatrix-idempotency-key")?.trim()
    || request.headers.get("x-request-id")?.trim();
  const suffix = stableId?.trim() || callerKey?.slice(0, 120) || crypto.randomUUID();
  return `product:${family}:${suffix}`.slice(0, 200);
}

export function hasMeaningfulProductField(
  input: Record<string, unknown>,
  field: string,
): boolean {
  const value = input[field];
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/**
 * The `@app[:action]` token leading a message, past invisible format
 * characters, and the message rewritten with that token canonical and shielded.
 */
function leadingAppMentionToken(body: string): {
  appId: string;
  actionId: string;
  canonicalToken: string;
  shieldedBody: string;
} | undefined {
  const trimmed = body.trim();
  const leadingFormatChars = trimmed.match(/^[\u200B-\u200D\uFEFF]*/u)?.[0] || "";
  const withoutLeadingFormatChars = trimmed.slice(leadingFormatChars.length);
  const match = withoutLeadingFormatChars.match(/^[@＠][\u200B-\u200D\uFEFF]*([A-Za-z0-9._-]+)(?::([A-Za-z0-9._-]+))?((?::\S*)?)(?:\s+|$)/u);
  if (!match) return undefined;
  const appId = match[1].trim().toLowerCase();
  const actionId = match[2]?.trim().toLowerCase() || "";
  const canonicalToken = `@${appId}${actionId ? `:${actionId}` : ""}`;
  const parameterTail = match[3] || "";
  const rest = withoutLeadingFormatChars.slice(match[0].length).trimStart();
  return {
    appId,
    actionId,
    canonicalToken,
    shieldedBody: `${shieldLeadingMentionToken(canonicalToken)}${parameterTail}${rest ? ` ${rest}` : ""}`,
  };
}

export function inferLeadingAppConnectorMention(body: string): { body: string; mention: ChannelAppMention } | undefined {
  const leading = leadingAppMentionToken(body);
  if (!leading) {
    return undefined;
  }

  const { appId, actionId, canonicalToken } = leading;
  const provider = getAppConnectorProvider(appId);
  if (!provider) {
    return undefined;
  }
  const action = actionId ? provider.actions.find((candidate) => candidate.id.toLowerCase() === actionId) : undefined;
  return {
    body: leading.shieldedBody,
    mention: {
      token: canonicalToken,
      appId: provider.id,
      appName: provider.name,
      status: provider.status,
      actionId: actionId || undefined,
      actionLabel: action?.label || legacyAppConnectorActionLabel(appId, actionId),
    },
  };
}

export function shieldLeadingMentionToken(token: string): string {
  return token.replace(/^@/, "@\u200B");
}

export function legacyAppConnectorActionLabel(appId: string, actionId: string): string | undefined {
  if (appId !== "github") return undefined;
  if (actionId === "issue_to_channel") return "Issue to channel";
  if (actionId === "issue_to_thread") return "Issue to thread";
  return undefined;
}

export function shieldKnownLeadingAppMention(body: string, appMentions: ChannelAppMention[]): string {
  const leading = leadingAppMentionToken(body);
  if (!leading) {
    return body;
  }

  const { appId, actionId } = leading;
  const hasMatchingAppMention = appMentions.some((mention) => {
    return mention.appId.trim().toLowerCase() === appId &&
      (mention.actionId?.trim().toLowerCase() || "") === actionId &&
      Boolean(getAppConnectorProvider(appId));
  });
  if (!hasMatchingAppMention) {
    return body;
  }
  return leading.shieldedBody;
}

export function channelAppMentionsForPublicMessage(
  body: string | undefined,
  appMentions: ChannelAppMention[] | undefined
): { body: string | undefined; appMentions: ChannelAppMention[] | undefined } {
  if (appMentions?.length && body) {
    return { body: shieldKnownLeadingAppMention(body, appMentions), appMentions };
  }
  if (appMentions?.length || !body) {
    return { body, appMentions };
  }
  const inferred = inferLeadingAppConnectorMention(body);
  if (!inferred) {
    return { body, appMentions };
  }
  return { body: inferred.body, appMentions: [inferred.mention] };
}

export function clientKey(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function internalClientHeaders(request: Request, headers?: HeadersInit): HeadersInit {
  return {
    ...headers,
    "x-client-key": clientKey(request),
  };
}

export function isLoginRateLimited(key: string, maxAttempts: number): boolean {
  const now = Date.now();
  const windowStart = now - LOGIN_RATE_LIMIT_WINDOW_MS;
  const timestamps = (loginRateLimits.get(key) || []).filter((value) => value > windowStart);
  if (timestamps.length >= maxAttempts) {
    loginRateLimits.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  loginRateLimits.set(key, timestamps);
  return false;
}

export function getDeviceAuthBroker(env: Env) {
  const id = env.DEVICE_AUTH.idFromName("default");
  return env.DEVICE_AUTH.get(id);
}

export {
  AUTOMATION_MAX_INTERVAL_MINUTES,
  AUTOMATION_MIN_INTERVAL_MINUTES,
} from "@xmatrix/protocol";
export const AUTOMATION_MUTABLE_PAYLOAD_FIELDS = [
  "name",
  "expression",
  "message",
  "intervalMinutes",
] as const;
export function automationPayload(
  current: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const nested = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown>
    : {};
  const { input: _serviceOwnedInput, ...safeNested } = nested;
  const payload = { ...current, ...safeNested };
  for (const field of AUTOMATION_MUTABLE_PAYLOAD_FIELDS) {
    if (input[field] !== undefined) payload[field] = input[field];
  }
  const suppliedLegacyDatum = input.message !== undefined || input.expression !== undefined ||
    nested.message !== undefined || nested.expression !== undefined;
  if (suppliedLegacyDatum) {
    delete payload.input;
    if (input.message !== undefined || nested.message !== undefined) delete payload.expression;
    if (input.expression !== undefined || nested.expression !== undefined) delete payload.message;
  }
  return payload;
}
export function automationIntervalMinutes(payload: Record<string, unknown>): number | undefined {
  const intervalMinutes = Math.floor(Number(payload.intervalMinutes));
  return isAutomationIntervalMinutes(intervalMinutes) ? intervalMinutes : undefined;
}
export function automationMessage(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const expression = automationDatumFromPayload(payload);
  const raw = expression
    ? { body: expression.text, appMentions: expression.appMentions }
    : payload.message;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const message = raw as Record<string, unknown>;
  if (typeof message.body !== "string") return undefined;
  const body = message.body.trim();
  if (!body || utf8ByteLength(body) > 64 * 1024) return undefined;
  if (message.appMentions !== undefined && !Array.isArray(message.appMentions)) return undefined;
  const explicitAppMentions = Array.isArray(message.appMentions)
    ? message.appMentions.filter((value): value is ChannelAppMention => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const mention = value as Record<string, unknown>;
        return typeof mention.token === "string" && typeof mention.appId === "string" &&
          typeof mention.appName === "string" &&
          (mention.status === "available" || mention.status === "planned");
      })
    : undefined;
  if (Array.isArray(message.appMentions) && explicitAppMentions?.length !== message.appMentions.length) {
    return undefined;
  }
  const interpreted = channelAppMentionsForPublicMessage(body, explicitAppMentions);
  const normalized = {
    body: interpreted.body || body,
    ...(interpreted.appMentions?.length ? { appMentions: interpreted.appMentions } : {}),
  };
  return utf8ByteLength(JSON.stringify(normalized)) <= 80 * 1024
    ? normalized
    : undefined;
}

export function automationExpression(
  payload: Record<string, unknown>,
  ref: string,
): Record<string, unknown> | undefined {
  const message = automationMessage(payload);
  if (!message) return undefined;
  const raw = payload.expression && typeof payload.expression === "object" &&
      !Array.isArray(payload.expression)
    ? payload.expression as Record<string, unknown>
    : undefined;
  if (raw && (raw.kind !== "text" || raw.language !== "natural-language" ||
      (raw.ref !== undefined && typeof raw.ref !== "string"))) return undefined;
  return {
    kind: "text",
    ref: typeof raw?.ref === "string" && raw.ref.trim() ? raw.ref.trim() : ref,
    language: "natural-language",
    text: message.body,
    ...(Array.isArray(message.appMentions) ? { appMentions: message.appMentions } : {}),
  };
}
export function automationEvalInput(
  expression: Record<string, unknown>,
  channelId: unknown,
  actor: { kind: "user" | "agent"; id: string },
  authorityRootUserId: string,
  intervalMinutes: number,
  lineage: unknown,
): Record<string, unknown> {
  return {
    datum: expression,
    envRef: { root: { kind: "channel", id: channelId }, actor, authorityRootUserId },
    resume: { kind: "interval", intervalMinutes },
    lineage,
  };
}
// Product UX media read-through companion to Authority channel-history: stream one
// attachment after Authority rechecks channel ACL without requiring Local Replica
// readiness. Replica capability path above remains the verified primary path.
// Relay V2 migration dual-path control plane is permanently retired.
// All /api/admin/relay-v2/migration/* methods refuse; Room remains for PITR only.

export async function deterministicChannelCreateId(userId: string, requestKey: string): Promise<string> {
  const digest = await sha256Hex(`create-channel\0${userId}\0${requestKey.slice(0, 120)}`);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

// memory-fabric v0 — generic channel annotations
// The durable authority phase is the only transport switch. Once Authority is
// active, Runtime failures propagate without a fallback path.
