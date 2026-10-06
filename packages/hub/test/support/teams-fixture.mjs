export const teamsApp = { providerId: "teams", appId: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222" };
export const teamsReference = { tenantId: teamsApp.tenantId, conversationId: "a:Opaque-Conversation_Bytes",
  conversationType: "personal", serviceUrl: "https://smba.trafficmanager.net/amer/", userId: "29:User-opaque",
  userObjectId: "33333333-3333-4333-8333-333333333333" };
export function teamsActivity(extra = {}) {
  return { type: "message", id: "1700000000001", channelId: "msteams", timestamp: new Date().toISOString(),
    serviceUrl: teamsReference.serviceUrl, from: { id: teamsReference.userId, aadObjectId: teamsReference.userObjectId },
    recipient: { id: `28:${teamsApp.appId}` }, conversation: { id: teamsReference.conversationId, conversationType: "personal", tenantId: teamsApp.tenantId },
    channelData: { tenant: { id: teamsApp.tenantId } }, text: "a normal message", ...extra };
}
