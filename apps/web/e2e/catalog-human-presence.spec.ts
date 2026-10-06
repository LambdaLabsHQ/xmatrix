import { expect, test } from "./fixtures";
import { refreshCatalogChannel } from "./channel-catalog-refresh";
import {
  E2E_CHANNEL, E2E_SPACE, E2E_DESKTOP_CONTEXT,
  installWorkspaceStubs,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

test("Human presence stays unknown until hydrated, survives omission, and accepts offline", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
  const member = page.locator(".app-detail-member-row").filter({ hasText: "E2E Tester" });
  await expect(member).toContainText("Status unknown");
  const snapshots = [
    { label: "online", presence: { "user:e2e-user": { kind: "user", status: "online" } } },
    { label: "online", presence: undefined },
    { label: "offline", presence: {} },
  ];
  for (const [index, snapshot] of snapshots.entries()) {
    const rule = `human-presence-${index}`;
    await refreshCatalogChannel(page, rule, { ...E2E_CHANNEL, name: rule,
      ...(snapshot.presence === undefined ? {} : { memberPresence: snapshot.presence }),
    });
    await expect(member).toContainText(snapshot.label);
    await expect(member).not.toContainText("Status unknown");
  }
});
