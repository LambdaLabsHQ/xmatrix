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

export function deviceProductName(client: string | null): string {
  if (client === "desktop") return "xMatrix Desktop";
  if (client === "ios") return "xMatrix iOS";
  if (client === "android") return "xMatrix Android";
  return "xMatrix CLI";
}

/**
 * Brings the app that asked back to the front once the browser approved it.
 * Opening the app's login page makes it ask for its session at once.
 */
export function nativeLoginReturnUrl(client: string | null): string | null {
  return client === "ios" || client === "android" || client === "desktop" ? NATIVE_LOGIN_RETURN_URL : null;
}
