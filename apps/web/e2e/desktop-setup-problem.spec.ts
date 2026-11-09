import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

/* Lines users' Windows machines reported when the App could not start its
   background service (redacted on the machine, as the App sends them). */
const DENIED = "error: Registering Scheduled Task xmatrix-daemon failed: Register-ScheduledTask : Access is denied.\n" +
  "At ~\\AppData\\Local\\Temp\\….ps1:38 char:3\n+   Register-ScheduledTask `\n+   ~~~~~~~~~~~~~~~~~~~~~~~~\n" +
  "+ CategoryInfo          : PermissionDenied: (PS_ScheduledTask:Root/Microsoft/...S_ScheduledTask) [Register-ScheduledTask], CimException";
const IN_USE = "error: 另一个程序正在使用此文件，进程无法访问。 (os error 32)";

async function openDesktopSetup(page: Parameters<typeof openWorkspaceWithStubs>[0], failure: { stage: string; detail: string; exitCode?: number }) {
  await page.addInitScript(({ now, failure }) => {
    // The App's bridge as a Windows desktop on its first screen: its background service failed.
    const nothing = async () => undefined;
    const context = { client: "win32", platform: "win32", version: "1.2.0", machineId: "machine:pc", hostId: "PC",
      hostName: "PC", isPackaged: true, startUrl: "" };
    const daemon = { state: "error", failure, updatedAt: now };
    (window as unknown as Record<string, unknown>).xmatrixDesktop = {
      client: context.client, platform: context.platform, getContext: async () => context,
      getDaemonStatus: async () => daemon, startDaemon: async () => daemon,
      getUpdateStatus: async () => ({ state: "disabled", enabled: false }),
      getSetupStatus: async () => ({ setupVersion: 1, completedAt: now }),
      checkCliInstalled: async () => ({ installed: true }), notify: async () => true,
      setBadge: nothing, setTitle: nothing, openExternal: nothing, openCliInstall: nothing, checkForUpdates: nothing,
      discoverAgentPresets: async () => [{ presetId: "claude", displayName: "Claude Code", runtime: "claude",
        runtimeAvailable: true, configDirs: [], workspaces: [] }],
    };
  }, { now: E2E_NOW, failure });
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [] });
  await fixtureJson(page, "machine-name", "**/api/xmatrix/machines/*/name", { machineId: "machine:pc", name: "PC" });
  await page.goto("/app/personal-sspaceperso");
}

test("Windows refusing the background task says why and how to get past it, with its own words folded away", async ({ page }) => {
  await openDesktopSetup(page, { stage: "cli_install", detail: DENIED, exitCode: 1 });
  const card = page.getByRole("group", { name: "Windows didn't let xMatrix register its background service" });
  await expect(card).toContainText("Run as administrator", { timeout: 20_000 });
  await expect(card.getByText("PermissionDenied", { exact: false })).toBeHidden();
  await expect(card).toHaveCSS("border-radius", "0px");
  await page.screenshot({ path: test.info().outputPath("desktop-setup-denied-after.png") });
  await card.getByText("Details", { exact: true }).click();
  await expect(card.getByText("PermissionDenied", { exact: false })).toBeVisible();
  await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a file an older xMatrix still holds says to quit it first", async ({ page }) => {
  await openDesktopSetup(page, { stage: "cli_install", detail: IN_USE, exitCode: 1 });
  const card = page.getByRole("group", { name: "An older xMatrix is still running and blocked the update" });
  await expect(card).toContainText("Task Manager", { timeout: 20_000 });
  await page.screenshot({ path: test.info().outputPath("desktop-setup-in-use-after.png") });
});

test("a failure with no known cause says what it means and keeps its own words", async ({ page }) => {
  await openDesktopSetup(page, { stage: "service_start", detail: "Command failed: schtasks /Run /TN xmatrix-daemon" });
  const card = page.getByRole("group", { name: "This computer didn't let xMatrix start its background service, so agents can't start here yet." });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();
});

test.describe("for a Chinese reader", () => {
  test.use({ locale: "zh-CN" });
  test("a file an older xMatrix still holds is explained in Chinese", async ({ page }) => {
    await openDesktopSetup(page, { stage: "cli_install", detail: IN_USE, exitCode: 1 });
    await expect(page.getByRole("group", { name: "旧版 xMatrix 还在运行，挡住了更新" }))
      .toContainText("任务管理器", { timeout: 20_000 });
    await page.screenshot({ path: test.info().outputPath("desktop-setup-in-use-after-zh.png") });
  });
});

test("an App signed in without a CLI session hands it one and starts its service, instead of showing a command", async ({ page }) => {
  // Production 11-08: the App was signed in, had no CLI and no CLI session,
  // reported the daemon "missing" and never asked for the session it needed.
  await page.addInitScript(({ now }) => {
    const nothing = async () => undefined;
    const context = { client: "darwin", platform: "darwin", version: "4.0.1", isPackaged: true, startUrl: "" };
    let daemon: Record<string, unknown> = { state: "missing", message: "xMatrix CLI was not found.", updatedAt: now };
    const calls: string[] = [];
    (window as unknown as Record<string, unknown>).desktopCalls = calls;
    (window as unknown as Record<string, unknown>).xmatrixDesktop = {
      client: context.client, platform: context.platform, getContext: async () => context,
      getDaemonStatus: async () => daemon,
      saveCliSession: async () => { calls.push("saveCliSession"); return { ok: true, updatedAt: now }; },
      startDaemon: async () => { calls.push("startDaemon"); daemon = { state: "running", pid: 42, updatedAt: now }; return daemon; },
      installCli: async () => ({ ok: true }),
      getUpdateStatus: async () => ({ state: "disabled", enabled: false }),
      getSetupStatus: async () => ({ setupVersion: 1, completedAt: now }),
      checkCliInstalled: async () => ({ installed: false }), notify: async () => true,
      setBadge: nothing, setTitle: nothing, openExternal: nothing, openCliInstall: nothing, checkForUpdates: nothing,
      discoverAgentPresets: async () => [],
    };
  }, { now: E2E_NOW });
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [] });
  await fixtureJson(page, "cli-exchange", "**/api/xmatrix/**/exchange-session", { token: "cli-token", refreshToken: "cli-refresh",
    user: { id: "user-1", email: "person@example.test" }, hubUrl: "https://hub.example.test", relayUrl: "wss://relay.example.test" });
  await page.goto("/app/personal-sspaceperso");
  await expect.poll(() => page.evaluate(() => (window as unknown as { desktopCalls: string[] }).desktopCalls),
    { timeout: 20_000 }).toEqual(["saveCliSession", "startDaemon"]);
});
