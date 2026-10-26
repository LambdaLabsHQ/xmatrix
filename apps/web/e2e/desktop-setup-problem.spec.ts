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
