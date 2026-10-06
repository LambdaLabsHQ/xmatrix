import { providerJson, ProviderRequestError } from "./http";

/** OAuth acceptance is verified with Netlify's read-only current-user endpoint. */
export async function verifyNetlify(credentials: Readonly<Record<string, string>>): Promise<void> {
  // Existing connections that only receive signed webhooks do not have an API token.
  if (!credentials.oauthToken) return;
  const user = await providerJson("https://api.netlify.com/api/v1/user", {
    headers: { authorization: `Bearer ${credentials.oauthToken}` },
  });
  if (typeof user.id !== "string" || !user.id) {
    throw new ProviderRequestError(502, "Netlify did not return an authenticated account");
  }
}
