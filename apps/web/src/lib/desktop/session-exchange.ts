import { WEB_PROXY_ROUTES, type AuthResponse } from "@xmatrix/protocol";
import type { DesktopCliSessionPayload } from "./bridge";
import { errorFromResponse, xmatrixRawResponse } from "../query/api-client";
import { unexpectedResponse } from "../user-facing-error";

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
