import { providerJson, providerUrl, ProviderRequestError } from "./http";

/** Both supported tenants use their official API origin; never send an app secret elsewhere. */
export function feishuApiUrl(credentials: Readonly<Record<string, string>>, path: string): URL {
  const raw = credentials.apiBase || "https://open.feishu.cn";
  let base: URL;
  try { base = new URL(raw); } catch { throw new ProviderRequestError(400, "Invalid Feishu API base"); }
  if (!["https://open.feishu.cn", "https://open.larksuite.com"].includes(base.origin) ||
      base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new ProviderRequestError(400, "Use the official Feishu or Lark API base");
  }
  return providerUrl(base.origin, `open-apis/${path}`);
}

export async function feishuTenantToken(credentials: Readonly<Record<string, string>>): Promise<string> {
  if (!credentials.appId || !credentials.appSecret) throw new ProviderRequestError(400, "Save both Feishu App ID and App Secret");
  const result = await providerJson(feishuApiUrl(credentials, "auth/v3/tenant_access_token/internal"), {
    method: "POST", json: { app_id: credentials.appId, app_secret: credentials.appSecret } });
  if (result.code !== 0 || typeof result.tenant_access_token !== "string" || !result.tenant_access_token) {
    throw new ProviderRequestError(401, "Feishu refused the app credentials");
  }
  return result.tenant_access_token;
}

export async function verifyFeishu(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (!credentials.appId && !credentials.appSecret) return; // Existing event-only configurations use the verification token.
  await feishuTenantToken(credentials);
}
