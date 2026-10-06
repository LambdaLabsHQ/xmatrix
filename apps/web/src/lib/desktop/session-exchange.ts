import { WEB_PROXY_ROUTES, type AuthResponse } from "@xmatrix/protocol";
import type { DesktopCliSessionPayload } from "./bridge";

export async function requestCliSessionExchange(token: string) {
  const exchangeResponse = await fetch(WEB_PROXY_ROUTES.cli_exchange_session, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const cliSession = (await exchangeResponse.json().catch(() => ({}))) as Partial<AuthResponse> & {
    error?: string;
  };
  return { exchangeResponse, cliSession };
}

export async function exchangeDesktopCliSession(token: string): Promise<DesktopCliSessionPayload> {
  const { exchangeResponse, cliSession } = await requestCliSessionExchange(token);
  if (!exchangeResponse.ok) {
    throw new Error(cliSession.error || "Failed to create a local daemon session.");
  }
  if (
    !cliSession.token ||
    !cliSession.refreshToken ||
    !cliSession.user ||
    !cliSession.hubUrl ||
    !cliSession.relayUrl
  ) {
    throw new Error("Local daemon session exchange response was incomplete.");
  }

  return {
    token: cliSession.token,
    refreshToken: cliSession.refreshToken,
    user: cliSession.user,
    hubUrl: cliSession.hubUrl,
    relayUrl: cliSession.relayUrl,
  };
}
