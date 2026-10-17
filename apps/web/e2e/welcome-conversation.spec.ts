import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE, fixtureChannelCatalog, fixtureJson,
  fixtureRequestBodies, fixtureRequests, fixtureRule, harnessRegistrations, installWorkspaceStubs, openWorkspaceWithStubs,
  releaseFixture,
} from "./workspace-fixtures";

const WELCOME = { ...E2E_CHANNEL, id: "channel-welcome", name: "Welcome to xMatrix", mode: "closed",
  messageCount: 1, lastMessageSequence: 1, updatedAt: E2E_NOW };
const XMATRIX = { identityId: "user:e2e-user", kind: "user", userId: "e2e-user", email: "e2e@xmatrix.test",
  label: "xMatrix", name: "xMatrix", avatarUrl: "/brand/xmatrix-management-icon.png" };
const step = (sequence: number, stage: string, body: string) => ({
  messageId: `system:welcome:${WELCOME.id}:${stage}`, channelId: WELCOME.id, sequence, body, sentAt: E2E_NOW, from: XMATRIX,
  metadata: { kind: "xmatrix.onboarding.v1", stage, xmatrixSystemNotice: true, xmatrixProvenance: "system_fact" },
});
const BRING = step(1, "bring-agents", "Bring your agents into xMatrix.");
const IN = step(2, "agents-in", "@codex is in. Mention it here to give it work.");

async function welcomeOnFirstOpen(page: import("@playwright/test").Page) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE] });
  await fixtureRule(page, { id: "welcome", pattern: `**/api/xmatrix/spaces/${E2E_SPACE.id}/welcome`, method: "POST",
    responder: { kind: "deferred", json: { channelId: WELCOME.id } } });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await expect.poll(async () => (await fixtureRequests(page, "welcome")).length, { timeout: 20_000 }).toBe(1);
  // While the Hub answers, nothing stands in for the conversation it makes.
  await expect(page.getByTestId("connect-machine")).not.toBeVisible();
  await fixtureChannelCatalog(page, "channel-catalog", [WELCOME]);
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${WELCOME.id}/history**`, { messages: [BRING], hasMore: false });
  await releaseFixture(page, "welcome");
}

/* The welcome once an agent is in: both steps written, a send to answer,
   and the conversation open. Returns the agents-in step. */
async function welcomeWithAgentIn(page: import("@playwright/test").Page,
  { harness = "codex", channel = {}, funnel = false }: { harness?: string; channel?: object; funnel?: boolean } = {}) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], registrations: harnessRegistrations([harness]),
    channels: [{ ...WELCOME, messageCount: 2, lastMessageSequence: 2, ...channel }] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${WELCOME.id}/history**`, { messages: [BRING, IN], hasMore: false });
  await fixtureJson(page, "send", `**/api/xmatrix/channels/${WELCOME.id}/messages`, { message: { id: "sent" } }, { method: "POST" });
  if (funnel) await fixtureRule(page, { id: "funnel", pattern: "**/api/xmatrix/observable/onboarding-step", method: "POST",
    responder: { kind: "static", status: 202, json: {} } });
  await page.goto("/app/personal-sspaceperso/channels/welcome-to-xmatrix-cchannelwel");
  return page.locator('[data-onboarding-stage="agents-in"]');
}

test.describe("desktop", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("a new personal Space opens xMatrix's welcome, which brings the agents in", async ({ page }) => {
    await welcomeOnFirstOpen(page);
    const welcome = page.getByTestId("connect-machine");
    await expect(welcome).toBeVisible({ timeout: 20_000 });
    await expect(welcome).toContainText("Bring your agents into xMatrix.");
    await expect(page.getByText("Welcome to xMatrix").first()).toBeVisible();
  });

  test("once an agent is in, a starter is sent as the person's own message to Auto", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page, { funnel: true });
    await expect(agentsIn).toContainText("@codex is in. Mention it here to give it work", { timeout: 20_000 });
    await agentsIn.getByRole("button", { name: /Plan something with me/u }).click();
    await expect.poll(async () => (await fixtureRequestBodies(page, "send")).map((sent) => (sent as { body?: string }).body))
      .toEqual(["@auto Help me plan something I'm working on, and keep the plan in a page as we go."]);
    // Which first task people choose is counted too.
    await expect.poll(() => fixtureRequestBodies(page, "funnel"))
      .toEqual([{ step: "starter_chosen", surface: "welcome", device: "desktop_web", starter: "plan" }]);
    // Until that agent is here there is nothing to address, and another starter would start a second one.
    await expect(agentsIn.getByRole("status")).toHaveText("Starting an agent…");
    await expect(agentsIn.getByRole("button", { name: /Write a page about my project/u })).toBeDisabled();
  });

  test("a starter goes to the agent already in the conversation instead of starting another", async ({ page }) => {
    const instance = (id: string, slot: string, status: string, lastSeenAt: string, extra: object = {}) =>
      ({ id, channelInstanceId: slot, label: `claude:${slot}`, connectedAt: E2E_NOW, lastSeenAt, status, ...extra });
    const memberPresence = {
      "agent:claude": { registration: { ownerUserId: "e2e-user", machineId: "machine-1", harness: "claude" }, kind: "agent",
        status: "idle", label: "claude", instances: [
          instance("instance-claude-1", "1", "offline", "2026-01-01T00:00:03.000Z", { rest: "wake_failed", restReason: "spawn_failed" }),
          instance("instance-claude-2", "2", "offline", "2026-01-01T00:00:02.000Z", { rest: "sleeping" }),
          instance("instance-claude-3", "3", "idle", "2026-01-01T00:00:01.000Z")] },
    };
    const agentsIn = await welcomeWithAgentIn(page, { harness: "claude", channel: { memberPresence } });
    await agentsIn.getByRole("button", { name: /Show me how to hand you work/u }).click({ timeout: 20_000 });
    // The working one first; one whose wake failed would not act on it.
    await expect.poll(async () => (await fixtureRequestBodies(page, "send")).map((sent) => (sent as { body?: string }).body))
      .toEqual(["@claude:3 Read https://xmatrix.sh/start.md and write a page on how I should hand you work through xMatrix."]);
  });
});

test.describe("an agent too old for xMatrix", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("is named with its version and updated in place, and nothing is sent to it before", async ({ page }) => {
    const daemon = {
      id: "daemon-laptop", userId: "e2e-user", email: "e2e@xmatrix.test", name: "Laptop", machineId: "machine:laptop",
      machineName: "Laptop", hostId: "host-laptop", hostName: "Laptop", status: "online", connectedAt: E2E_NOW,
      lastSeenAt: new Date().toISOString(), daemonVersion: "1.0.515",
      metadata: { platform: "macos", capabilities: ["machine_harness_action_v1"], harnesses: { schemaVersion: 1, capturedAt: E2E_NOW,
        items: [{ id: "claude", installed: true, probeStatus: "ok", version: "2.1.302" },
          { id: "cursor", installed: true, probeStatus: "ok", version: "2025.09.12-4852336" }] } },
    };
    await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [WELCOME], machineDaemons: [daemon] });
    await fixtureJson(page, "history", `**/api/xmatrix/channels/${WELCOME.id}/history**`, { messages: [BRING], hasMore: false });
    await fixtureRule(page, { id: "update", pattern: "**/api/xmatrix/machine-daemons/harness-actions", method: "POST",
      responder: { kind: "static", status: 202, json: { controlId: "control-update", status: "queued" } } });
    await fixtureJson(page, "update-status", "**/api/xmatrix/machine-daemons/harness-actions/control-update",
      { controlId: "control-update", presetId: "cursor", action: "update", status: "succeeded" });
    await page.goto("/app/personal-sspaceperso/channels/welcome-to-xmatrix-cchannelwel");
    const welcome = page.getByTestId("connect-machine");
    await expect(welcome).toContainText("Found Claude Code and Cursor.", { timeout: 20_000 });
    await expect(welcome).toContainText("Cursor CLI on Laptop is 2025.09.12, too old for xMatrix, which needs 2026.01.01 or later.");
    await welcome.getByRole("button", { name: "Update Cursor CLI" }).click();
    await expect.poll(() => fixtureRequestBodies(page, "update")).toEqual([
      { machineId: "machine:laptop", hostId: "host-laptop", presetId: "cursor", action: "update" },
    ]);
  });
});

test.describe("desktop app", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("the desktop app keeps its own first screen, which finds this computer's agents", async ({ page }) => {
    await page.addInitScript(() => {
      const now = new Date().toISOString();
      (window as unknown as Record<string, unknown>).xmatrixDesktop = {
        client: "desktop", platform: "darwin",
        getContext: async () => ({ client: "desktop", platform: "darwin", version: "0.16.600", hostId: "Laptop",
          hostName: "Laptop", isPackaged: true, startUrl: "" }),
        setBadge: async () => undefined, setTitle: async () => undefined, notify: async () => true,
        openExternal: async () => undefined, checkCliInstalled: async () => ({ installed: true }),
        openCliInstall: async () => undefined, checkForUpdates: async () => undefined,
        getUpdateStatus: async () => ({ state: "disabled", enabled: false }),
        getDaemonStatus: async () => ({ state: "running", pid: 1, updatedAt: now }),
        startDaemon: async () => ({ state: "running", pid: 1, updatedAt: now }),
        getSetupStatus: async () => ({ setupVersion: 1, completedAt: now }),
        discoverAgentPresets: async () => [],
      };
    });
    await welcomeOnFirstOpen(page);
    await expect(page.getByText("No agent runtime found on Laptop", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Welcome to xMatrix", { exact: true }).first()).toBeVisible();
    await expect(page).not.toHaveURL(/welcome/u);
  });
});

test.describe("mobile", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("a phone lists xMatrix's welcome instead of an empty Space", async ({ page }) => {
    await welcomeOnFirstOpen(page);
    await expect(page.locator(".app-mobile-channel-list-pane").getByText("Welcome to xMatrix", { exact: true }))
      .toBeVisible({ timeout: 20_000 });
  });
});

test.describe("a Chinese browser", () => {
  test.use({ ...E2E_DESKTOP_CONTEXT, locale: "zh-CN" });

  test("is welcomed, set up and given its starters in Chinese", async ({ page }) => {
    await welcomeOnFirstOpen(page);
    await expect.poll(() => fixtureRequestBodies(page, "welcome")).toEqual([{ locale: "zh" }]);
    const welcome = page.getByTestId("connect-machine");
    await expect(welcome).toContainText("把你的 Agent 带进 xMatrix。", { timeout: 20_000 });
    await expect(welcome).toContainText("在你的电脑上运行这条命令");
    await expect(welcome).toContainText("在这里批准");
    await expect(welcome).toContainText("下载桌面 App");
  });

  test("starters are sent in Chinese", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page);
    await expect(agentsIn).toContainText("@codex 已接入。在这里 @ 它就能派活", { timeout: 20_000 });
    await agentsIn.getByRole("button", { name: /和我一起做个计划/u }).click();
    await expect.poll(async () => (await fixtureRequestBodies(page, "send")).map((sent) => (sent as { body?: string }).body))
      .toEqual(["@auto 帮我规划一件正在做的事，边聊边把计划写进一个页面。"]);
  });
});
