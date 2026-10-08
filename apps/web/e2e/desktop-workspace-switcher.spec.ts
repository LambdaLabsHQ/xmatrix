import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

test("expanded desktop workspace switcher is one glass panel floating over the list", async ({ page }) => {
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

  /* At rest the header is the name and the chevron at the row's end, with
     no glass of its own. */
  const trigger = page.locator(".app-space-switcher-trigger");
  await expect(trigger).not.toContainText("LL");
  await expect(trigger).not.toContainText(/\b(Pro|Free)\b/u);
  await expect(page.locator(".app-space-switcher-rename")).toHaveCount(0);
  const rest = await trigger.evaluate((element) => {
    const chevron = element.querySelector(".app-space-switcher-chevron")!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { chevronGap: box.right - chevron.right, backdrop: style.backdropFilter, shadow: style.boxShadow };
  });
  expect(rest.chevronGap).toBeLessThanOrEqual(16);
  expect(rest.backdrop).toBe("none");
  expect(rest.shadow).toBe("none");

  // Opening floats the panel over the list; the list does not move.
  const list = page.locator(".app-sidebar-pane-body");
  const listTop = (await list.boundingBox())!.y;
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const menu = page.locator(".app-space-switcher-menu");
  await expect(menu).toBeVisible();
  expect((await list.boundingBox())!.y).toBe(listTop);

  /* The expanded shell carries the shared liquid glass recipe — the
     composer's fill, lens and rim — and nothing more but a floating
     surface's drop shadow. Comparing it against a live probe of the generic
     glass class stays true when that recipe is retuned: a private recipe on
     the shell (an extra rim, a top edge highlight, caustic gradients, its own
     backdrop filter) makes one of these reads differ. */
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
  const { boxShadow: shellShadow, ...shellGlass } = material.shell;
  const { boxShadow: sharedShadow, ...sharedGlass } = material.sharedRecipe;
  expect(shellGlass).toEqual(sharedGlass);
  // Same rim, and a heavier shadow than the composer's lift.
  const rim = sharedShadow.split(/,(?![^(]*\))/u).filter((layer) => layer.includes("inset"));
  for (const layer of rim) expect(shellShadow).toContain(layer.trim());
  expect(shellShadow).toContain("0px 14px 36px -8px");

  // Nothing inside the panel is a second pane of glass but the action discs,
  // even under the pointer.
  await trigger.hover();
  for (const inner of [trigger, menu, page.getByRole("button", { name: "Manage", exact: true })]) {
    expect(await inner.evaluate((element) => getComputedStyle(element).backdropFilter)).toBe("none");
  }

  /* A Space is one row: its avatar in the Space's own ink, its name, its
     member count; under the pointer the row takes a flat inset highlight. */
  const row = page.locator(".app-space-switcher-option", { hasText: "Personal" });
  await row.hover();
  const paint = await row.evaluate((element) => {
    const shellNode = element.closest(".app-space-switcher-shell-open")!;
    const avatar = element.querySelector(".app-space-avatar")!;
    const style = getComputedStyle(element);
    const rowBox = element.getBoundingClientRect();
    const shellBox = shellNode.getBoundingClientRect();
    return {
      background: style.backgroundColor,
      backdrop: style.backdropFilter,
      shadow: style.boxShadow,
      avatarInk: getComputedStyle(avatar).color,
      avatarFill: getComputedStyle(avatar).backgroundColor,
      inside: rowBox.left >= shellBox.left && rowBox.right <= shellBox.right,
    };
  });
  expect(paint.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(paint.backdrop).toBe("none");
  expect(paint.shadow).toBe("none");
  expect(paint.avatarInk).not.toBe(paint.avatarFill);
  expect(paint.inside).toBe(true);
  await expect(row).toContainText("1 member");
  await expect(page.locator(".app-space-switcher-option[aria-selected='true']")).toContainText("Lambda Labs");

  // Renaming starts from the panel, not from a pencil on the header.
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Workspace name" })).toHaveValue("Lambda Labs");
});

test("Team lists every workspace and tags the one you are in", async ({ page }) => {
  const otherSpace = { ...E2E_SPACE, id: "space-team", name: "Lambda Labs" };
  await openWorkspaceWithStubs(page, {
    spaces: [otherSpace, E2E_SPACE],
    channels: [{ ...E2E_CHANNEL, spaceId: otherSpace.id }],
  });

  await page.locator(".app-space-switcher-trigger").click();
  await page.getByRole("button", { name: "Manage", exact: true }).click();

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
