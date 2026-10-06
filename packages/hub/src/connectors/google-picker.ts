import type { Env } from "../types";
import { connectionCredentials } from "./connection-credentials";
import { connectorCredentialRepository } from "./credentials";
import { providerJson, ProviderRequestError } from "./http";
import { oauthClient } from "./oauth";

export interface GooglePickerConfiguration { clientId: string; apiKey: string; appId: string }

/** Public browser parameters only. Neither the client secret nor any Space token is returned. */
export function googlePickerConfiguration(env: Env): GooglePickerConfiguration {
  const client = oauthClient(env, "google");
  const variables = env as unknown as Record<string, unknown>;
  const apiKey = variables.CONNECTOR_GOOGLE_PICKER_API_KEY;
  const appId = variables.CONNECTOR_GOOGLE_PICKER_APP_ID;
  if (!client || typeof apiKey !== "string" || !/^[A-Za-z0-9_-]{20,200}$/u.test(apiKey) ||
      typeof appId !== "string" || !/^\d{6,20}$/u.test(appId)) {
    throw new ProviderRequestError(503, "Google file selection is not configured yet");
  }
  return { clientId: client.clientId, apiKey, appId };
}

async function adminConnection(env: Env, spaceId: string, userId: string) {
  const repository = connectorCredentialRepository(env);
  // The credential store owns the current owner/admin decision. This read exports no fields.
  await repository.readGenerated({ requestId: crypto.randomUUID(), spaceId, providerId: "google", actorUserId: userId,
    generated: [] });
  const connection = await repository.resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "google" });
  if (!connection || connection.status !== "configured" || !connection.values.oauthToken) {
    throw new ProviderRequestError(409, "Connect Google Docs & Drive to this Space first");
  }
  return connection;
}

export async function configuredGooglePicker(env: Env, spaceId: string, userId: string): Promise<GooglePickerConfiguration> {
  await adminConnection(env, spaceId, userId);
  return googlePickerConfiguration(env);
}

/** Browser file ids are untrusted. Confirm them with this Space's server-held Google grant. */
export async function confirmGooglePickerFile(env: Env, spaceId: string, userId: string, fileId: string) {
  if (!/^[A-Za-z0-9_-]{10,200}$/u.test(fileId)) throw new ProviderRequestError(400, "Invalid Google file id");
  await adminConnection(env, spaceId, userId);
  const values = await connectionCredentials(env, spaceId, "google");
  const before = await adminConnection(env, spaceId, userId);
  if (before.values.oauthToken !== values.oauthToken) throw new ProviderRequestError(409, "Google connection changed; select the file again");
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
  url.searchParams.set("fields", "id,name,mimeType,trashed,isAppAuthorized");
  const file = await providerJson(url, { headers: { authorization: `Bearer ${values.oauthToken}` } });
  if (file.id !== fileId || typeof file.name !== "string" || !file.name || file.trashed === true ||
      file.isAppAuthorized !== true || !["application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet"].includes(String(file.mimeType))) {
    throw new ProviderRequestError(403, "Choose a Google Doc or Sheet authorized to the Space's connected account");
  }
  // Recheck current role, configured state and grant after the external call. Reconnects invalidate stale confirmations.
  const after = await adminConnection(env, spaceId, userId);
  if (after.version !== before.version) throw new ProviderRequestError(409, "Google connection changed; select the file again");
  const kind = file.mimeType === "application/vnd.google-apps.spreadsheet" ? "sheet" : "doc";
  return { file: { id: fileId, name: file.name.slice(0, 250), kind,
    url: `https://docs.google.com/${kind === "sheet" ? "spreadsheets" : "document"}/d/${fileId}/edit` } };
}
