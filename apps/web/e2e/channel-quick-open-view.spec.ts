import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_SPACE,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

test("Ctrl+P reveals the selected channel in the list", async ({ page }) => {
  const channels = Array.from({ length: 18 }, (_, index) => ({
    ...E2E_CHANNEL,
    id: `channel-${index.toString().padStart(2, "0")}`,
    name: `project-${index.toString().padStart(2, "0")}`,
    updatedAt: `2026-07-01T00:${(59 - index).toString().padStart(2, "0")}:00.000Z`,
  }));
  const target = channels[17];
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels });
  const pane = page.locator('.app-sidebar-pane-body');
  const row = pane.locator(`[data-channel-row-id="${target.id}"]`);
  await expect(row).toBeAttached();
  await expect(row).not.toBeInViewport();

  await page.keyboard.press("Control+p");
  const search = page.getByPlaceholder("Type a channel or thread name");
  await search.fill(target.name);
  await search.press("Enter");

  await expect(search).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/channels/${target.name}--${target.id}$`));
  await expect(row).toHaveClass(/app-channel-row-active/);
  await expect(row).toBeInViewport();
});
