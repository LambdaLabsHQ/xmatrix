import { ProviderRequestError } from "../http";

/** The bearer header for a Google connection; `product` names the connector to connect when the token is missing. */
export function googleHeaders(credentials: Readonly<Record<string, string>>, product = "Google Docs & Drive"): Record<string, string> {
  const token = credentials.oauthToken;
  if (!token || token.length > 16_384 || /\s/u.test(token)) {
    throw new ProviderRequestError(401, `Connect ${product} with OAuth first`);
  }
  return { authorization: `Bearer ${token}` };
}
