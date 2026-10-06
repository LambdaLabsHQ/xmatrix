import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_SPACE, installWorkspaceStubs } from "./workspace-fixtures";
import { fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";

for (const width of [393, 1280]) {
  test(`transfer needs two separate Human actions at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.routeWebSocket("**/ws/humans*", socket => { socket.onMessage(() => undefined); });
    await fixtureJson(page, "runtime-disabled", "**/api/relay-v2/**", { error: "Fixture realtime disabled" }, { status: 503 });
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
    const proposal = { id: "transfer-one", sourceSpaceId: E2E_SPACE.id, targetSpaceId: "target-space",
      channelId: E2E_CHANNEL.id, sourceName: "Personal", targetName: "Team", status: "pending",
      expiresAt: "2099-01-01T00:00:00Z", tree: [{ id: E2E_CHANNEL.id, name: "General" }],
      lostUserIds: ["former-reader"], lostAgentIds: [], lostUsers: [{ id: "former-reader", name: "Previous reader" }],
      outbound: null as null | { userId: string }, inbound: null as null | { userId: string },
      canAckOutbound: true, canAckInbound: true };
    const queue = `**/api/xmatrix/spaces/${E2E_SPACE.id}/channel-transfers**`;
    await fixtureJson(page, "transfer-list", queue, { proposals: [proposal] }, { method: "GET" });
    await fixtureJson(page, "transfer-ack", `**/api/xmatrix/spaces/${E2E_SPACE.id}/channel-transfers/transfer-one/ack`,
      { proposal }, { method: "POST" });
    await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
    const card = page.getByRole("region", { name: "Channel transfer confirmations" });
    await expect(card).toBeVisible();
    await card.getByText("1 Channels · review access changes").click();
    await expect(card.getByText(/Previous reader/)).toBeVisible();
    await fixtureJson(page, "transfer-list", queue, { proposals: [{ ...proposal, outbound: { userId: "e2e-user" } }] }, { method: "GET" });
    await card.getByRole("button", { name: "Confirm outbound" }).click();
    await expect(card.getByRole("button", { name: "Confirm outbound" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Confirm inbound" })).toBeEnabled();
    expect(await fixtureRequestBodies(page, "transfer-ack")).toEqual([{ role: "outbound" }]);
    await page.screenshot({ path: testInfo.outputPath("transfer-awaiting-inbound.png") });
    await fixtureJson(page, "transfer-list", queue, { proposals: [{ ...proposal, status: "completed",
      outbound: { userId: "e2e-user" }, inbound: { userId: "e2e-user" } }] }, { method: "GET" });
    await card.getByRole("button", { name: "Confirm inbound" }).click();
    await expect(card.getByText(/Transfer completed/)).toBeVisible();
    expect(await fixtureRequestBodies(page, "transfer-ack")).toEqual([{ role: "outbound" }, { role: "inbound" }]);
  });
}
