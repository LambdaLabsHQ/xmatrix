import type { DesktopContext } from "@/lib/desktop/bridge";

export type NativeLoginClient = "desktop" | "ios" | "android";

const NATIVE_LOGIN_RETURN_URL = "xmatrix://login";

export function normalizeNativeLoginClient(
  client?: string | null,
  platform?: string | null,
): NativeLoginClient {
  if (client === "android" || platform === "android") return "android";
  if (client === "ios" || platform === "ios") return "ios";
  return "desktop";
}

export function nativeLoginClientFromContext(
  context: Pick<DesktopContext, "client" | "platform">,
): NativeLoginClient {
  return normalizeNativeLoginClient(context.client, context.platform);
}

export function deviceClientLabel(client: string | null): string {
  if (client === "desktop") return "desktop app";
  if (client === "ios") return "iOS app";
  if (client === "android") return "Android app";
  return "terminal";
}

export function nativeAppLabel(client: NativeLoginClient): string {
  if (client === "ios") return "iOS app";
  if (client === "android") return "Android app";
  return "desktop app";
}

export function authorizationLabel(client: string | null): string {
  if (client === "desktop") return "Desktop Authorization";
  if (client === "ios") return "iOS Authorization";
  if (client === "android") return "Android Authorization";
  return "CLI Authorization";
}

export function deviceProductName(client: string | null): string {
  if (client === "desktop") return "xMatrix Desktop";
  if (client === "ios") return "xMatrix iOS";
  if (client === "android") return "xMatrix Android";
  return "xMatrix CLI";
}

export function nativeLoginReturnUrl(client: string | null): string | null {
  return client === "ios" || client === "android" ? NATIVE_LOGIN_RETURN_URL : null;
}
