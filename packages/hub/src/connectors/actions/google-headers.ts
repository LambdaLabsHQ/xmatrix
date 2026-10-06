import { ProviderRequestError } from "../http";

export function googleHeaders(credentials: Readonly<Record<string, string>>): Record<string, string> {
  const token = credentials.oauthToken;
  if (!token || token.length > 16_384 || /\s/u.test(token)) {
    throw new ProviderRequestError(401, "Connect Google Docs & Drive with OAuth first");
  }
  return { authorization: `Bearer ${token}` };
}
