import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

// The former suffix wizard is retired. auto-launch.spec.ts covers tag selection,
// sequential keyboard conditions and the submitted invocation.
test.describe("tag launch targets and retired suffixes", () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
  test.beforeEach(async ({ page }) => {
    await openWorkspaceWithStubs(page, {
      spaces: [E2E_SPACE], channels: [E2E_CHANNEL],
      registrations: [{ key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "machine-mac", harness: "codex" },
        displayName: "codex", machineName: "Devs-MacBook-Pro" }],
      launchTargets: { repos: [{ value: "LambdaLabsHQ/xmatrix" }], workspaces: [{
        ownerUserId: "e2e-user", machineId: "machine-mac", hostId: "host-mac",
        hostName: "Devs-MacBook-Pro", canonicalCwd: "/Users/dev/scratch/notes",
        displayName: "notes", lastSeenAt: E2E_NOW,
      }] },
    });
    await page.goto("/app/personal-sspaceperso/channels/channel-general");
    await expect(page.locator("textarea.composer-textarea").first()).toBeVisible();
  });

  test("retired suffixes never open the start-action or target wizard", async ({ page }) => {
    const textarea = page.locator("textarea.composer-textarea").first();
    for (const draft of ["@codex:", "@codex:new:", "@codex:once:"]) {
      await textarea.fill(draft);
      await expect(page.getByRole("option").filter({ hasText: "Start persistent instance" })).toHaveCount(0);
      await expect(page.getByRole("option").filter({ hasText: "Run one-shot task" })).toHaveCount(0);
      await expect(page.getByRole("option").filter({ hasText: "LambdaLabsHQ/xmatrix" })).toHaveCount(0);
      await expect(textarea).toHaveValue(draft);
    }
  });

  test("tag search distinguishes repositories from machine-bound directories", async ({ page }) => {
    const textarea = page.locator("textarea.composer-textarea").first();
    await textarea.fill("@auto repo:LambdaLabsHQ");
    const overlay = page.locator(".app-mention-suggestions");
    const repo = overlay.getByRole("option").filter({ hasText: "LambdaLabsHQ/xmatrix" });
    await expect(repo).toHaveCount(1);
    await expect(repo).toContainText("Repository");
    await expect(repo).not.toContainText("Devs-MacBook-Pro");
    await textarea.fill("@auto pwd:scratch/notes");
    const directory = overlay.getByRole("option").filter({ hasText: "/Users/dev/scratch/notes" });
    await expect(directory).toHaveCount(1);
    await expect(directory).toContainText("Directory");
    await expect(directory).toContainText("Devs-MacBook-Pro");
    expect(await overlay.evaluate(node => node.parentElement?.classList.contains("app-composer-box"))).toBe(true);
    expect(await overlay.evaluate(node => node.classList.contains("app-liquid-glass-surface"))).toBe(false);
  });

  test("IME Enter does not accept a mention or create a launch tag", async ({ page }) => {
    const textarea = page.locator("textarea.composer-textarea").first();
    await textarea.fill("@codex");
    const overlay = page.locator(".app-mention-suggestions");
    await expect(overlay).toBeVisible();
    await textarea.evaluate(node => {
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      node.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, isComposing: true, key: "Enter", keyCode: 229,
      }));
    });
    await expect(textarea).toHaveValue("@codex");
    await expect(overlay).toBeVisible();
    await textarea.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  });
});
