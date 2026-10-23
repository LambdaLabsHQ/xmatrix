import { WEB_PROXY_ROUTES, type AuthResponse } from "@xmatrix/protocol";
import type { DesktopBridge, DesktopCliSessionPayload } from "./bridge";
import { errorFromResponse, xmatrixRawResponse, unexpectedResponse } from "../query/api-client";

export async function requestCliSessionExchange(token: string) {
  const exchangeResponse = await xmatrixRawResponse(WEB_PROXY_ROUTES.cli_exchange_session, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!exchangeResponse.ok) throw await errorFromResponse(exchangeResponse);
  return (await exchangeResponse.json().catch(() => ({}))) as Partial<AuthResponse>;
}

export async function exchangeDesktopCliSession(token: string): Promise<DesktopCliSessionPayload> {
  const cliSession = await requestCliSessionExchange(token);
  if (
    !cliSession.token ||
    !cliSession.refreshToken ||
    !cliSession.user ||
    !cliSession.hubUrl ||
    !cliSession.relayUrl
  ) {
    throw unexpectedResponse("The local daemon session");
  }

  return {
    token: cliSession.token,
    refreshToken: cliSession.refreshToken,
    user: cliSession.user,
    hubUrl: cliSession.hubUrl,
    relayUrl: cliSession.relayUrl,
  };
}

/**
 * Signing the desktop app in also signs this computer's CLI and daemon in with
 * a session of their own. That part may fail (an old daemon, no CLI yet)
 * without failing the app's own sign-in.
 */
export async function handDesktopSessionToCli(bridge: DesktopBridge | null, token: string): Promise<void> {
  if (!bridge?.saveCliSession) return;
  try {
    await bridge.saveCliSession(await exchangeDesktopCliSession(token));
    await bridge.startDaemon?.();
  } catch (cliError) {
    console.warn("Signed in, but this computer's CLI session could not be updated", cliError);
  }
}
