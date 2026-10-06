import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson, installWorkspaceStubs } from "./workspace-fixtures";

test.use(E2E_MOBILE_CONTEXT);

const INSTANCE = "channel-general:1";
const agentMessage = (sequence: number, body: string) => ({
  messageId: `message-rhythm-${sequence}`, channelId: E2E_CHANNEL.id, sequence, body, sentAt: E2E_NOW,
  from: { kind: "agent", identityId: `agent:${INSTANCE}`, agentId: INSTANCE, userId: "owner-0", email: "",
    label: "claude", agentName: "claude", instanceId: INSTANCE, channelInstanceId: "1", instanceLabel: "claude",
    goal: { active: true, objective: "Ship the mobile pages", status: "active", updatedAt: E2E_NOW },
    gitBranch: "feat-mobile-pages", model: "claude-opus-5-5", effort: "xhigh" },
});

// A phone showed each message ending above an empty band (an add-reaction row
// that only appears on hover) and the header's last tag cut in half at the edge.
test("a phone stacks messages without reserved rows and wraps every header tag whole", async ({ page }) => {
  await installWorkspaceStubs(page, {
    spaces: [{ ...E2E_SPACE, members: [...E2E_SPACE.members, { userId: "owner-0", name: "Yiming Hu",
      email: "owner-0@example.test", role: "member", joinedAt: E2E_NOW }] }],
    channels: [{ ...E2E_CHANNEL, messageCount: 2, lastMessageSequence: 2, updatedAt: E2E_NOW, memberPresence: {
      [INSTANCE]: { kind: "agent", status: "busy", label: "claude",
        registration: { ownerUserId: "owner-0", machineId: "machine:build01", harness: "claude" },
        instances: [{ id: INSTANCE, channelInstanceId: "1", label: "claude", status: "busy",
          hostName: "build01", connectedAt: E2E_NOW, lastSeenAt: E2E_NOW }] } } }],
    registrations: [{ key: { spaceId: E2E_SPACE.id, ownerUserId: "owner-0", machineId: "machine:build01", harness: "claude" },
      displayName: "claude", machineName: "Build box" }],
  });
  await fixtureJson(page, "channel-general-history", "**/api/xmatrix/channels/channel-general/history**", {
    hasMore: false, messages: [agentMessage(1, "Types pass; updating tests next."), agentMessage(2, "Local e2e passed; opening the PR.")] });
  await page.goto("/app/personal-sspaceperso/channels/channel-general");

  const rows = page.locator(".app-message-row");
  await expect(rows).toHaveCount(2);
  const first = rows.first();
  // The owner's Machine name, never the hostname the instance reported.
  await expect(first.locator("[data-status-chip=machine]")).toHaveText("Build box");
  await expect(first.getByRole("button", { name: "Add reaction" })).toBeHidden();

  // The row ends where its body ends.
  const gap = await first.evaluate((row) => {
    const body = row.querySelector(".rich-message")!.getBoundingClientRect();
    return row.getBoundingClientRect().bottom - body.bottom;
  });
  expect(gap).toBeLessThanOrEqual(8);

  // Every tag is on screen in full, above the body: tags wrap, none is hidden or cut.
  const tags = await first.evaluate((row) => {
    const body = row.querySelector(".rich-message")!.getBoundingClientRect();
    return Array.from(row.querySelectorAll(
      "[data-status-chip], .app-goal-status-badge, .app-message-branch-badge",
    )).map((tag) => {
      const r = tag.getBoundingClientRect();
      const whole = r.width > 0 && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= body.top + 0.5;
      return `${tag.textContent}: ${whole ? "whole" : `cut ${JSON.stringify(r)}`}`;
    });
  });
  expect(tags.length).toBeGreaterThanOrEqual(5);
  for (const tag of tags) expect(tag).toMatch(/: whole$/u);

  await page.screenshot({ path: test.info().outputPath("mobile-message-rhythm.png") });

  // A tap on a message opens its actions side by side, directly under it.
  await first.locator(".rich-message").tap();
  const actions = first.getByRole("toolbar", { name: "Message actions" });
  await expect(actions).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  const buttons = actions.getByRole("button");
  await expect(buttons.getByText("Reply", { exact: true })).toBeVisible();
  await expect(buttons.getByText("Copy", { exact: true })).toBeVisible();
  const layout = await first.evaluate((row) => {
    const body = row.querySelector(".rich-message")!.getBoundingClientRect();
    const toolbar = row.querySelector("[role=toolbar]")!.getBoundingClientRect();
    const tops = Array.from(row.querySelectorAll(".app-mobile-inline-action"))
      .map((button) => Math.round(button.getBoundingClientRect().top));
    return { below: toolbar.top >= body.bottom - 0.5, oneRow: new Set(tops).size === 1, count: tops.length };
  });
  expect(layout).toEqual({ below: true, oneRow: true, count: 3 });
  await expect(rows.nth(1).getByRole("toolbar")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("mobile-message-inline-actions.png") });

  // Reacting starts from the same row.
  await actions.getByRole("button", { name: "React" }).tap();
  await expect(actions.getByRole("group", { name: "Quick reactions" }).getByRole("button")).not.toHaveCount(0);

  // A second tap on the message closes it; a tap on another message moves it there.
  await first.locator(".rich-message").tap();
  await expect(actions).toHaveCount(0);
  await first.locator(".rich-message").tap();
  await rows.nth(1).locator(".rich-message").tap();
  await expect(actions).toHaveCount(0);
  await expect(rows.nth(1).getByRole("toolbar", { name: "Message actions" })).toBeVisible();
});
