import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, E2E_USER_SENDER, fixtureJson, fixtureRequestBodies,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const MACHINE = "machine:studio";
const CHANNEL = { ...E2E_CHANNEL, messageCount: 2, lastMessageSequence: 2, updatedAt: E2E_NOW };
const SUMMON = { messageId: "summon", channelId: CHANNEL.id, sequence: 1, body: "@zcode fix the login page", sentAt: E2E_NOW,
  from: { ...E2E_USER_SENDER, identityId: "user:e2e-user" } };
const offline = [{ machineId: MACHINE, machineName: "studio" }];
const NOTICE = { messageId: "notice", channelId: CHANNEL.id, sequence: 2, sentAt: E2E_NOW,
  body: "Agent launch failed: studio is offline, so nothing was launched. Turn it on and open xMatrix there " +
    "(the desktop app, or `xmatrix setup daemon` in a terminal), then send your message again. No launch was allocated. " +
    "(registration_daemon_offline)",
  from: { kind: "user", identityId: "user:e2e-user", userId: "e2e-user", email: "e2e@xmatrix.test", label: "xMatrix",
    name: "xMatrix", avatarUrl: "/brand/xmatrix-management-icon.png" },
  metadata: { kind: "xmatrix.machine-offline.v1", offline, sourceMention: "@zcode", sourceMessageId: "summon",
    xmatrixSystemNotice: true, xmatrixProvenance: "system_fact" } };
const REJECTION = { invocationId: "routing-preflight:summon:0", channelId: CHANNEL.id, sourceMessageId: "summon",
  sourceMention: "@zcode", targetRef: "auto", code: "registration_daemon_offline", offline,
  message: NOTICE.body.replace(/^Agent launch failed: /u, "").replace(/ \(registration_daemon_offline\)$/u, ""),
  rejectedAt: E2E_NOW, evidenceExpiresAt: E2E_NOW };

function registrations(online: boolean, ownerUserId = "e2e-user") {
  return [{ key: { spaceId: E2E_SPACE.id, ownerUserId, machineId: MACHINE, harness: "zcode" },
    displayName: "zcode", ownerName: "E2E Tester", machineName: "studio", version: 1, state: "enabled", models: [],
    routingReady: true, canManageOwnerGrant: true, canConfigureSpace: true, canRemoveFromSpace: true,
    live: { machine: { online, lastSeenAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), platform: "macos" }, running: [] } }];
}

async function openRefusedSummon(page: Parameters<typeof openWorkspaceWithStubs>[0], options: {
  ownerUserId?: string; notice?: typeof NOTICE; rejection?: Record<string, unknown> } = {}) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], registrations: registrations(false, options.ownerUserId), channels: [CHANNEL] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`,
    { messages: [SUMMON, options.notice ?? NOTICE], hasMore: false });
  await fixtureJson(page, "invocations", `**/api/xmatrix/channels/${CHANNEL.id}/agent-launches/query`,
    { launches: [], rejections: [options.rejection ?? REJECTION], continuations: [] });
  await fixtureJson(page, "launch-anyway", `**/api/xmatrix/channels/${CHANNEL.id}/messages/summon/launch-anyway`,
    { launchIds: ["launch-again"] }, { method: "POST" });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  return page.getByRole("group", { name: "studio is offline" });
}

test("a summon refused because its computer is offline says how to bring it back, then sends again once it is", async ({ page }) => {
  const card = await openRefusedSummon(page);
  await expect(card).toContainText("@zcode didn't start, because xMatrix can't reach that computer right now.", { timeout: 20_000 });
  await expect(card).toContainText("Make sure studio is on and connected to the internet.");
  await expect(card).toContainText("xmatrix setup daemon");
  await expect(card).toContainText("Still offline · last seen 2 hours ago");
  await expect(card.getByRole("button", { name: "Send again" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Send again" })).toHaveCSS("border-radius", "0px");
  await page.locator('[id="message:summon"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("machine-offline-after.png") });
  // The machine comes back: the card says so and the author's summon goes again, exactly as written.
  await fixtureJson(page, "registration-catalog", "**/api/xmatrix/spaces/*/agent-registrations",
    { capabilities: [], registrations: registrations(true) });
  await expect(card).toContainText("studio is back online", { timeout: 20_000 });
  await page.screenshot({ path: test.info().outputPath("machine-offline-back-online.png") });
  // Paper has no rounded corners: the card and what is on it are square.
  await expect(card).toHaveCSS("border-radius", "0px");
  await expect(card.getByRole("button", { name: "Send again" })).toHaveCSS("border-radius", "0px");
  await card.getByRole("button", { name: "Send again" }).click();
  await expect(card).toContainText("Your message went to it again.");
  await expect.poll(() => fixtureRequestBodies(page, "launch-anyway"))
    .toEqual([{ body: "@zcode fix the login page", sourceMention: "@zcode" }]);
});

test("someone else's offline computer is named without steps they cannot take", async ({ page }) => {
  const card = await openRefusedSummon(page, { ownerUserId: "someone-else" });
  await expect(card).toContainText("This computer belongs to someone else in this Space.", { timeout: 20_000 });
  await expect(card).not.toContainText("xmatrix setup daemon");
});

test("a notice from a Hub that did not name the machine reads as written", async ({ page }) => {
  const metadata = { xmatrixSystemNotice: true, xmatrixProvenance: "system_fact" };
  await openRefusedSummon(page, { notice: { ...NOTICE, metadata: metadata as unknown as typeof NOTICE.metadata, body: "Agent launch failed: This machine is offline, so nothing was launched. " +
    "It can be used again when it reconnects. No launch was allocated. (registration_daemon_offline)" },
    rejection: { ...REJECTION, offline: undefined, message: "This machine is offline, so nothing was launched. It can be used again when it reconnects. No launch was allocated." } });
  await expect(page.locator('[id="message:notice"]')).toContainText("It can be used again when it reconnects.", { timeout: 20_000 });
  await page.screenshot({ path: test.info().outputPath("machine-offline-before.png") });
});

test.describe("in Chinese", () => {
  test.use({ locale: "zh-CN" });
  test("the card follows the reader's language", async ({ page }) => {
    await openRefusedSummon(page);
    const card = page.getByRole("group", { name: "studio 离线了" });
    await expect(card).toContainText("@zcode 没有启动", { timeout: 20_000 });
    await expect(card).toContainText("怎么恢复");
    await page.screenshot({ path: test.info().outputPath("machine-offline-after-zh.png") });
  });
});
