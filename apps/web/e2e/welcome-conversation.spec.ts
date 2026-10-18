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
  { harness = "codex", channel = {}, funnel = false, sent, login, repositories }:
  { harness?: string | string[]; channel?: object; funnel?: boolean; sent?: string; login?: string; repositories?: object } = {}) {
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
    channels: [{ ...WELCOME, messageCount: 2, lastMessageSequence: 2, ...channel }] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${WELCOME.id}/history**`, { messages: [BRING, IN], hasMore: false });
  await fixtureJson(page, "send", `**/api/xmatrix/channels/${WELCOME.id}/messages`, { message: sent === undefined ? { id: "sent" }
    : { messageId: "sent", channelId: WELCOME.id, sequence: 3, body: sent, sentAt: E2E_NOW,
      from: { ...E2E_USER_SENDER, identityId: "user:e2e-user" } } }, { method: "POST" });
  if (repositories) await fixtureJson(page, "repositories", "**/page-migration/import/repositories", repositories);
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

  test("once an agent is in, a card starts a new conversation for the person to say what they want", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page, { funnel: true });
    await expect(agentsIn).toContainText("@codex is in. Mention it here to give it work", { timeout: 20_000 });
    await agentsIn.getByRole("button", { name: /Start a new conversation/u }).click();
    await expect(page.getByRole("textbox", { name: "What should happen" })).toBeVisible();
    // Which card people choose is counted.
    await expect.poll(() => fixtureRequestBodies(page, "funnel"))
      .toEqual([{ step: "starter_chosen", surface: "welcome", device: "desktop_web", starter: "talk" }]);
  });

  test("an agent whose program is signed out is named with its machine and signed in here, with no starters", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page, { harness: "claude", login: "signed_out" });
    await expect(agentsIn).toContainText("Claude Code on Workstation is not signed in, so it cannot take work yet.",
      { timeout: 20_000 });
    await expect(agentsIn.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(agentsIn).not.toContainText("is in. Mention it here");
    await expect(agentsIn.getByRole("button", { name: /Start a new conversation/u })).toHaveCount(0);
  });

  test("a signed-in agent of the person's own is in, with its starters", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page, { harness: "claude", login: "signed_in" });
    await expect(agentsIn).toContainText("@claude is in. Mention it here to give it work", { timeout: 20_000 });
    await expect(page.getByTestId("signed-out-agent")).toHaveCount(0);
  });

  test("the first starter makes a page and opens it to be co-written with the agent", async ({ page }) => {
    // Grok is in too, but co-writing waits on every line: the fast writer is the one asked.
    const agentsIn = await welcomeWithAgentIn(page, { harness: ["grok", "claude"], login: "signed_in" });
    await fixtureJson(page, "page-create", /\/api\/xmatrix\/spaces\/[^/]+\/pages$/u, { page: { pageId: "p-first",
      title: "What I'm working on", parentPageId: null, position: "a", accessMode: "open", headRevision: 1,
      createdAt: E2E_NOW, updatedAt: E2E_NOW } }, { method: "POST" });
    const first = agentsIn.getByRole("button", { name: /Write something with AI/u });
    await expect(first).toContainText("You write a line. @claude writes the next.", { timeout: 20_000 });
    await first.click();
    await expect.poll(() => fixtureRequestBodies(page, "page-create")).toEqual([{ title: "What I'm working on" }]);
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("xmatrix:co-write:p-first"))).toBe("claude");
    await expect(page).toHaveURL(/p-first|pfirst/u);
  });

  test("bring your work in: a Space without GitHub is offered the connect", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page, { repositories: { repos: [], repoStatus: "not-connected" } });
    await expect(agentsIn.getByTestId("bring-work-in")).toContainText("Bring your work in. Connect GitHub", { timeout: 20_000 });
    await expect(agentsIn.getByRole("button", { name: "Connect GitHub", exact: true })).toBeVisible();
  });

  test("bring your work in: a Space with GitHub drafts pages from a repository", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page,
      { repositories: { repos: [{ value: "acme/site" }, { value: "acme/api" }], repoStatus: "authorized" } });
    await fixtureJson(page, "import", "**/page-migration/import", { conversationId: "channel-import" }, { method: "POST" });
    await agentsIn.getByRole("button", { name: "acme/api", exact: true }).click({ timeout: 20_000 });
    await expect.poll(() => fixtureRequestBodies(page, "import")).toEqual([{ repository: "acme/api" }]);
    await expect(agentsIn.getByTestId("bring-work-in")).toContainText("Turning acme/api into pages.");
  });

  test("with two agents in, a card opens a new conversation that calls both to work together", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page, { harness: ["claude", "codex"] });
    const together = agentsIn.getByRole("button", { name: /Get several AIs working together/u });
    await expect(together).toContainText("@claude and @codex split the work", { timeout: 20_000 });
    await together.click();
    await expect(page.getByRole("textbox", { name: "What should happen" }))
      .toContainText("@claude @codex Work on this together and split it between you:");
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

  test("is welcomed, set up and given its starters in Chinese", async ({ page }) => {
    await welcomeOnFirstOpen(page);
    await expect.poll(() => fixtureRequestBodies(page, "welcome")).toEqual([{ locale: "zh" }]);
    const welcome = page.getByTestId("connect-machine");
    await expect(welcome).toContainText("把你的 Agent 带进 xMatrix。", { timeout: 20_000 });
    await expect(welcome).toContainText("在你的电脑上运行这条命令");
    await expect(welcome).toContainText("在这里批准");
    await expect(welcome).toContainText("下载桌面 App");
  });

  test("its cards are in Chinese, and working together waits for a second agent", async ({ page }) => {
    const agentsIn = await welcomeWithAgentIn(page);
    await expect(agentsIn).toContainText("@codex 已接入。在这里 @ 它就能派活", { timeout: 20_000 });
    await expect(agentsIn.getByRole("button", { name: /开一个新对话/u })).toBeEnabled();
    const together = agentsIn.getByRole("button", { name: /让多个 AI 一起协作/u });
    await expect(together).toContainText("再接一个 AI，就能让它们一起协作。");
    await expect(together).toBeDisabled();
  });
});
