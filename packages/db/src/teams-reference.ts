import { sha256Hex } from "@xmatrix/protocol";
import { AppControlError } from "./app-control.js";

export const MICROSOFT_GUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export interface TeamsAppIdentity { providerId: "teams"; appId: string; tenantId: string }
export interface TeamsConversationReference {
  tenantId: string; conversationId: string; conversationType: "personal" | "groupChat";
  serviceUrl: string; userId: string; userObjectId: string;
}
export function teamsAppIdentity(app: TeamsAppIdentity): string {
  if (app.providerId !== "teams" || !MICROSOFT_GUID.test(app.appId) || !MICROSOFT_GUID.test(app.tenantId)) {
    throw new AppControlError("invalid_app_request", 400, "Invalid Teams app identity");
  }
  return ["teams", app.tenantId, app.appId].join("|");
}
/** Commercial-cloud destinations only. These URLs never come from a Human selection. */
export function teamsServiceUrl(value: string): string {
  const fail = () => { throw new AppControlError("invalid_app_request", 400, "Invalid Teams service URL"); };
  if (typeof value !== "string" || value.length > 256) return fail();
  let url: URL;
  try { url = new URL(value); } catch { return fail(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !["smba.trafficmanager.net", "smba.infra.teams.microsoft.com"].includes(url.hostname) ||
      !/^\/[A-Za-z0-9_.-]{1,80}\/$/u.test(url.pathname) || url.href !== value) return fail();
  return value;
}
export function teamsReference(value: TeamsConversationReference, app: TeamsAppIdentity): TeamsConversationReference {
  teamsAppIdentity(app);
  const opaque = (v: unknown, limit: number) => typeof v === "string" && v.length > 0 && v.length <= limit &&
    /^[A-Za-z0-9_:;@.+=/-]+$/u.test(v);
  if (!value || value.tenantId !== app.tenantId || !["personal", "groupChat"].includes(value.conversationType) ||
      !opaque(value.conversationId, 512) || !opaque(value.userId, 512) || !value.userId.startsWith("29:") ||
      !MICROSOFT_GUID.test(value.userObjectId)) {
    throw new AppControlError("invalid_app_request", 400, "Invalid Teams conversation");
  }
  return { tenantId: app.tenantId, conversationId: value.conversationId, conversationType: value.conversationType,
    serviceUrl: teamsServiceUrl(value.serviceUrl), userId: value.userId, userObjectId: value.userObjectId };
}
export async function teamsRoomId(reference: TeamsConversationReference): Promise<string> {
  return `room-${await sha256Hex(JSON.stringify([reference.tenantId, reference.conversationId]))}`;
}
