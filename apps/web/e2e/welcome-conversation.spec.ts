import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE, E2E_USER_SENDER, fixtureChannelCatalog, fixtureJson,
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

/* The welcome once an agent is in: both steps written, a send to answer
   (with the message `sent`, when given, as the Hub stores it), and the
   conversation open. Returns the agents-in step. */
async function welcomeWithAgentIn(page: import("@playwright/test").Page,
  { harness = "codex", channel = {}, funnel = false, sent, login, repositories, firstStepOnly = false }:
  { harness?: string | string[]; channel?: object; funnel?: boolean; sent?: string; login?: string; repositories?: object;
    firstStepOnly?: boolean } = {}) {
  const harnesses = Array.isArray(harness) ? harness : [harness];
  // With `login`, the agent is the person's own and its machine reports that sign-in state.
  const registrations = harnessRegistrations(harnesses).map((registration) => login
    ? { ...registration, key: { ...registration.key, ownerUserId: "e2e-user" } } : registration);
  const machineDaemons = login ? [{ id: "daemon-1", userId: "e2e-user", email: "e2e@xmatrix.test", name: "Workstation",
    machineId: "machine", machineName: "Workstation", hostId: "host-1", hostName: "Workstation", status: "online",
    connectedAt: E2E_NOW, lastSeenAt: new Date().toISOString(), daemonVersion: "1.0.546",
    metadata: { platform: "macos", capabilities: ["machine_harness_action_v1", "machine_harness_login_v1"],
      harnesses: { schemaVersion: 1, capturedAt: E2E_NOW, items:
        harnesses.map((id) => ({ id, installed: true, probeStatus: "ok", version: "2.1.170", login })) } } }] : undefined;
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], registrations, machineDaemons,
    channels: [{ ...WELCOME, messageCount: firstStepOnly ? 1 : 2, lastMessageSequence: firstStepOnly ? 1 : 2, ...channel }] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${WELCOME.id}/history**`,
    { messages: firstStepOnly ? [BRING] : [BRING, IN], hasMore: false });
  await fixtureJson(page, "send", `**/api/xmatrix/channels/${WELCOME.id}/messages`, { message: sent === undefined ? { id: "sent" }
    : { messageId: "sent", channelId: WELCOME.id, sequence: 3, body: sent, sentAt: E2E_NOW,
      from: { ...E2E_USER_SENDER, identityId: "user:e2e-user" } } }, { method: "POST" });
  if (repositories) await fixtureJson(page, "repositories", "**/page-migration/import/repositories", repositories);
  if (funnel) await fixtureRule(page, { id: "funnel", pattern: "**/api/xmatrix/observable/onboarding-step", method: "POST",
    responder: { kind: "static", status: 202, json: {} } });
  await page.goto("/app/personal-sspaceperso/channels/welcome-to-xmatrix-cchannelwel");
  return page.locator('[data-onboarding-stage="agents-in"]');
}

for (const [name, context] of [["desktop", E2E_DESKTOP_CONTEXT], ["phone", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(`${name} first welcome`, () => {
    test.use(context);

    test("an enabled agent can be signed in before any agent can take work", async ({ page }) => {
      await welcomeWithAgentIn(page, { harness: "claude", login: "signed_out", firstStepOnly: true });
      const welcome = page.getByTestId("connect-machine");
      await expect(welcome).toContainText("Claude Code on Workstation is not signed in, so it cannot take work yet.");
      await expect(welcome.getByRole("listitem").last()).toContainText("claude");
      await expect(welcome.locator("pre")).toHaveCount(0);
      await expect(page.locator('[data-onboarding-stage="agents-in"]')).toHaveCount(0);
      const start = "harness:00000000-0000-4000-8000-0000000000c1";
      await fixtureJson(page, "welcome-sign-in", "**/api/xmatrix/machine-daemons/harness-actions",
        { controlId: start, status: "queued" }, { method: "POST" });
      await fixtureJson(page, "welcome-sign-in-status", `**/api/xmatrix/machine-daemons/harness-actions/${start}`,
        { controlId: start, presetId: "claude", action: "login_start", status: "queued" });
      await welcome.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(welcome.getByRole("button", { name: "Starting sign-in…", exact: true })).toBeVisible();
      expect(await fixtureRequestBodies(page, "welcome-sign-in")).toEqual([
        { machineId: "machine", hostId: "host-1", presetId: "claude", action: "login_start" },
      ]);
    });
  });
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

  test("once an agent is in, xMatrix says so in one line, and the composer below says how to give it work", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page);
    await expect(agentsIn).toHaveText(/^@codex is in\. Mention it here to give it work\./u, { timeout: 20_000 });
    // No menu of starters: typing @ in the composer is the way in.
    await expect(agentsIn.locator("li")).toHaveCount(0);
    await expect(agentsIn.getByRole("button", { name: /new conversation|together|Write something|another computer/u })).toHaveCount(0);
  });

  test("an agent whose program is signed out is named with its machine and signed in here", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page, { harness: "claude", login: "signed_out" });
    await expect(agentsIn).toContainText("Claude Code on Workstation is not signed in, so it cannot take work yet.",
      { timeout: 20_000 });
    await expect(agentsIn.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(agentsIn).not.toContainText("is in. Mention it here");
  });

  test("a signed-in agent of the person's own is in", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page, { harness: "claude", login: "signed_in" });
    await expect(agentsIn).toContainText("@claude is in. Mention it here to give it work", { timeout: 20_000 });
    await expect(page.getByTestId("signed-out-agent")).toHaveCount(0);
  });

  test("a Space without GitHub is offered the connect, for agents to work across its repositories", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page, { repositories: { repos: [], repoStatus: "not-connected" } });
    await expect(agentsIn.getByTestId("bring-work-in")).toContainText("Connect GitHub so agents can work in several repositories in parallel.", { timeout: 20_000 });
    await expect(agentsIn.getByRole("button", { name: "Connect GitHub", exact: true })).toBeVisible();
  });

  test("once GitHub is connected, the welcome says nothing more about it", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page,
      { repositories: { repos: [{ value: "acme/site" }, { value: "acme/api" }], repoStatus: "authorized" } });
    await expect(agentsIn).toContainText("@codex is in.", { timeout: 20_000 });
    await expect(agentsIn.getByTestId("bring-work-in")).toHaveCount(0);
    await expect(agentsIn.getByRole("button", { name: "acme/api" })).toHaveCount(0);
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

test.describe("a Mac browser", () => {
  test.use({ ...E2E_DESKTOP_CONTEXT,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });

  test("is offered the app first, with the terminal one click away", async ({ page }) => {
    // Most new people left within half a minute of a terminal command (11-01);
    // on a Mac or PC the app connects the computer without one.
    await welcomeOnFirstOpen(page);
    const welcome = page.getByTestId("connect-machine");
    await expect(welcome).toContainText("Get the xMatrix app on this computer", { timeout: 20_000 });
    await expect(welcome.getByRole("link", { name: "Download for macOS" })).toHaveAttribute("href", /latest-(arm64|x64)\.dmg$/u);
    await expect(welcome).not.toContainText("--connect");
    await expect(welcome).not.toContainText("Approve it here");
    await welcome.screenshot({ path: test.info().outputPath("app-first-mac.png") });
    await welcome.getByRole("button", { name: "Use a terminal instead" }).click();
    await expect(welcome).toContainText("Run this on your computer");
    await expect(welcome).toContainText("Approve it here");
  });
});

test.describe("a Windows browser in Chinese", () => {
  test.use({ ...E2E_DESKTOP_CONTEXT, locale: "zh-CN",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });

  test("is offered the Windows installer first", async ({ page }) => {
    await welcomeOnFirstOpen(page);
    const welcome = page.getByTestId("connect-machine");
    await expect(welcome).toContainText("在这台电脑上装 xMatrix App", { timeout: 20_000 });
    await expect(welcome.getByRole("link", { name: "下载 Windows 版" })).toHaveAttribute("href", /latest-x64\.exe$/u);
    await expect(welcome.getByRole("button", { name: "改用终端" })).toBeVisible();
    await welcome.screenshot({ path: test.info().outputPath("app-first-windows-zh.png") });
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

  test("on a phone, the welcome sends the person to their computer with the same email, not a command", async ({ page }) => {
    await welcomeOnFirstOpen(page);
    await page.locator(".app-mobile-channel-list-pane").getByText("Welcome to xMatrix", { exact: true }).click({ timeout: 20_000 });
    const welcome = page.getByTestId("connect-machine");
    await expect(welcome).toContainText("On your computer, open xmatrix.sh and sign in with this same email", { timeout: 20_000 });
    await expect(welcome).not.toContainText("--connect");
    await expect(welcome).not.toContainText("Approve it here");
  });
});

test.describe("a Chinese browser", () => {
  test.use({ ...E2E_DESKTOP_CONTEXT, locale: "zh-CN" });

  test("is welcomed and set up in Chinese", async ({ page }) => {
    await welcomeOnFirstOpen(page);
    await expect.poll(() => fixtureRequestBodies(page, "welcome")).toEqual([{ locale: "zh" }]);
    const welcome = page.getByTestId("connect-machine");
    await expect(welcome).toContainText("把你的 Agent 带进 xMatrix。", { timeout: 20_000 });
    await expect(welcome).toContainText("在你的电脑上运行这条命令");
    await expect(welcome).toContainText("在这里批准");
    await expect(welcome).toContainText("下载桌面 App");
  });

  test("is told in Chinese that its agent is in", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page);
    await expect(agentsIn).toHaveText(/^@codex 已接入。在这里 @ 它就能派活。/u, { timeout: 20_000 });
  });
});
