import { expect, test } from "./fixtures";
import { expectDraft } from "./composer-draft";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE,
  installWorkspaceStubs, routeHumanSocket } from "./workspace-fixtures";

// Resolver unit fixtures already carry presence. This exercises the real split:
// Channel metadata holds no Instances; the composer must subscribe to their store.
for (const mobile of [false, true]) test.describe(mobile ? "phone" : "desktop", () => {
  test.use(mobile ? E2E_MOBILE_CONTEXT : E2E_DESKTOP_CONTEXT);

  test("Instance commands complete from the live store through both entry points", async ({ page }) => {
    const instance = { id: `${E2E_CHANNEL.id}:1`, channelId: E2E_CHANNEL.id, channelInstanceId: "1",
      label: "codex:1", agentName: "codex", status: "busy", connectedAt: E2E_NOW, lastSeenAt: E2E_NOW,
      registration: { ownerUserId: "e2e-user", machineId: "machine", harness: "codex" },
      commands: [{ token: "/compact", label: "Compact context", mode: "passthrough" }],
      revision: { version: 1, sequence: 1 } };
    const socket = await routeHumanSocket(page, (frame, reply) => {
      if (frame.type === "ping") reply({ type: "pong", requestId: frame.requestId });
    });
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [
      { ...E2E_CHANNEL, memberPresence: {}, instanceRecords: [instance] },
    ] });
    await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
    const input = page.locator(".composer-textarea").first();
    const suggestions = page.locator(".app-mention-suggestions");
    const compact = suggestions.getByRole("option").filter({ hasText: "Compact context" });
    await input.fill("/");
    await expect(compact).toBeVisible();
    await compact.click();
    await expectDraft(input, "@codex:1 /compact ");

    await input.fill("@codex:1 /");
    await expect(compact).toBeVisible();
    await input.press("Tab");
    await expectDraft(input, "@codex:1 /compact ");

    await input.fill("/");
    await expect(compact).toBeVisible();
    await expect.poll(socket.connections).toBeGreaterThan(0);
    const updated = { ...instance, commands: [{ token: "/review", label: "Review changes", mode: "passthrough" }],
      revision: { version: 1, sequence: 2 } };
    socket.send({ type: "instance_records", records: [updated] });
    const review = suggestions.getByRole("option").filter({ hasText: "Review changes" });
    await expect(review).toBeVisible();
    await expect(compact).toHaveCount(0);
    // Late metadata and a stale report cannot replace the current catalog.
    socket.send({ type: "channel_updated", channel: { ...E2E_CHANNEL, memberPresence: {}, instanceRecords: [] } });
    socket.send({ type: "instance_records", records: [instance] });
    await input.fill("@codex:1 /");
    await expect(review).toBeVisible();
    await expect(compact).toHaveCount(0);
    // An authoritative empty catalog clears native commands. Fixed xMatrix
    // controls, such as Codex's goal control, keep their separate contract.
    socket.send({ type: "instance_records", records: [{ ...updated, commands: [], revision: { version: 1, sequence: 3 } }] });
    await expect(review).toHaveCount(0);
    await expect(compact).toHaveCount(0);
    await input.fill("/");
    await expect(review).toHaveCount(0);
    await expect(compact).toHaveCount(0);
  });
});
