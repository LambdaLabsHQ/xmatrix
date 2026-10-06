import { expect, type Page } from "@playwright/test";
import { fixtureChannelCatalog, fixtureRequests } from "./workspace-fixtures";

/** Wait for a replacement snapshot to reach the row before checking its presence. */
export async function refreshCatalogChannel(
  page: Page,
  rule: string,
  channel: Record<string, unknown> & { id: string; spaceId: string; name: string },
): Promise<void> {
  await fixtureChannelCatalog(page, rule, [channel]);
  await page.evaluate(spaceId => window.dispatchEvent(new CustomEvent(
    "xmatrix:channel-catalog-change", { detail: { spaceId, kind: "structure" } },
  )), channel.spaceId);
  await expect.poll(async () => (await fixtureRequests(page, rule)).length).toBeGreaterThan(0);
  // A list with no viewport mounts no rows. On a phone the desktop sidebar is
  // display:none while a conversation is open, and the phone list itself is
  // not mounted then. Only require the row where a list is actually showing.
  const listShowing = page.locator(".app-sidebar:visible, .app-mobile-channel-list-pane:visible");
  if (await listShowing.count()) {
    await expect(page.locator(`[data-channel-row-id="${channel.id}"]`).first()).toContainText(channel.name);
  }
}
