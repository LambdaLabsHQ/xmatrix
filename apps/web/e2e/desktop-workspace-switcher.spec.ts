import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

test("expanded desktop workspace switcher uses only its outer glass surface", async ({ page }) => {
  const otherSpace = {
    ...E2E_SPACE,
    id: "space-team",
    name: "Lambda Labs",
  };
  const teamChannel = {
    ...E2E_CHANNEL,
    spaceId: otherSpace.id,
  };

  await openWorkspaceWithStubs(page, { spaces: [otherSpace, E2E_SPACE], channels: [teamChannel] });

  const trigger = page.locator(".app-space-switcher-trigger");
  await expect(trigger).not.toContainText("LL");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  const menu = page.locator(".app-space-switcher-menu");
  await expect(menu).toBeVisible();
  const causticContents = await Promise.all(
    [trigger, menu].map((locator) => locator.evaluate((element) => getComputedStyle(element, "::before").content))
  );
  expect(causticContents).toEqual(["none", "none"]);

  /* The expanded shell must carry the shared liquid glass recipe and nothing
     more. Comparing it against a live probe of the generic glass class stays
     true when that recipe is retuned, and it is wider than any "no bright
     inset" check: a private recipe reintroduced on the shell — an extra rim, a
     top edge highlight, caustic gradients, its own backdrop filter — makes one
     of these four reads differ. */
  const shell = page.locator(".app-space-switcher-shell-open");
  await expect(shell).toBeVisible();
  const material = await shell.evaluate((element) => {
    const read = (node: Element) => {
      const own = getComputedStyle(node);
      const caustics = getComputedStyle(node, "::before");
      return {
        boxShadow: own.boxShadow,
        backdropFilter: own.backdropFilter,
        backgroundColor: own.backgroundColor,
        causticImage: caustics.backgroundImage,
      };
    };

    const probe = document.createElement("div");
    probe.className = "app-liquid-glass-fill";
    element.parentElement?.appendChild(probe);
    const sharedRecipe = read(probe);
    probe.remove();

    return { shell: read(element), sharedRecipe };
  });

  expect(material.shell).toEqual(material.sharedRecipe);

  const row = page.locator(".app-space-switcher-row", { hasText: "Personal" });
  await row.hover();
  const paint = await row.evaluate((element) => {
    const shellNode = element.closest(".app-space-switcher-shell-open");
    const option = element.querySelector(".app-space-switcher-option");
    const openWindow = element.querySelector(".app-space-switcher-open-window");
    if (!shellNode || !option) return null;
    const rowBox = element.getBoundingClientRect();
    const shellBox = shellNode.getBoundingClientRect();
    const rowStyle = getComputedStyle(element);
    const optionStyle = getComputedStyle(option);
    const iconStyle = openWindow ? getComputedStyle(openWindow) : null;
    return {
      rowRadius: rowStyle.borderRadius,
      rowBackground: rowStyle.backgroundColor,
      optionBackground: optionStyle.backgroundColor,
      optionBackdrop: optionStyle.backdropFilter,
      iconBackground: iconStyle?.backgroundColor ?? "",
      iconBackdrop: iconStyle?.backdropFilter ?? "",
      iconColor: iconStyle?.color ?? "",
      optionColor: optionStyle.color,
      rowLeft: rowBox.left,
      rowRight: rowBox.right,
      shellLeft: shellBox.left,
      shellRight: shellBox.right,
    };
  });
  expect(paint).not.toBeNull();
  expect(paint!.rowRadius === "0px" || paint!.rowRadius === "0px 0px 0px 0px").toBe(true);
  expect(paint!.rowBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(paint!.optionBackground).toBe("rgba(0, 0, 0, 0)");
  expect(paint!.optionBackdrop).toBe("none");
  if (paint!.iconBackground) {
    expect(paint!.iconBackground).toBe("rgba(0, 0, 0, 0)");
    expect(paint!.iconBackdrop).toBe("none");
    expect(paint!.iconColor).toBe(paint!.optionColor);
  }
  expect(Math.abs(paint!.rowLeft - paint!.shellLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(paint!.rowRight - paint!.shellRight)).toBeLessThanOrEqual(1);
});

test("Team lists every workspace and tags the one you are in", async ({ page }) => {
  const otherSpace = { ...E2E_SPACE, id: "space-team", name: "Lambda Labs" };
  await openWorkspaceWithStubs(page, {
    spaces: [otherSpace, E2E_SPACE],
    channels: [{ ...E2E_CHANNEL, spaceId: otherSpace.id }],
  });

  await page.locator(".app-space-switcher-trigger").click();
  await page.getByRole("button", { name: "Manage workspaces" }).click();

  await expect(page).toHaveURL(/\/team$/);
  const rows = page.locator('[data-testid="tool-section-row"]');
  const current = rows.filter({ hasText: "Lambda Labs" });
  const personal = rows.filter({ hasText: E2E_SPACE.name });
  await expect(current).toContainText("Current");
  await expect(personal).toBeVisible();
  await expect(personal).not.toContainText("Current");
  await expect(rows.filter({ hasText: "All workspaces" })).toHaveCount(0);

  // The Space you are in is managed beside the list.
  const view = page.locator(".app-tool-detail");
  await expect(view.getByRole("heading", { level: 2, name: "Lambda Labs" })).toBeVisible();

  // Another Space offers to switch to it.
  await personal.click();
  await expect(view.getByRole("heading", { level: 2, name: E2E_SPACE.name })).toBeVisible();
  await expect(view.getByRole("button", { name: `Open ${E2E_SPACE.name}` })).toBeVisible();

  // A new workspace is the list's +, its first row, not one of the workspaces.
  await expect(rows.filter({ hasText: "New workspace" })).toBeHidden();
  await page.locator(".app-tool-list .app-list-create", { hasText: "New workspace" }).click();
  await expect(view.getByRole("textbox", { name: "New workspace name" })).toBeVisible();
});
