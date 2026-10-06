import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use({
  deviceScaleFactor: 2,
  hasTouch: false,
  isMobile: false,
  viewport: { height: 800, width: 1280 },
});

const VIEWER_PRESENCE = {
  "user:viewer": {
    kind: "user",
    status: "online",
    label: "Yiming Hu",
    focused: true,
  },
};

test("channel rows show an avatar only for humans focused on that channel", async ({ page }) => {
  const focusedChannel = {
    ...E2E_CHANNEL,
    memberPresence: VIEWER_PRESENCE,
  };
  const unfocusedChannel = {
    ...E2E_CHANNEL,
    id: "channel-random",
    name: "random",
    updatedAt: E2E_NOW,
    memberPresence: {
      "user:viewer": {
        ...VIEWER_PRESENCE["user:viewer"],
        focused: false,
      },
    },
  };

  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [focusedChannel, unfocusedChannel],
  });

  const focusedRow = page.locator('[data-channel-row-id="channel-general"]');
  const unfocusedRow = page.locator('[data-channel-row-id="channel-random"]');
  await expect(focusedRow.getByLabel("Yiming Hu Human online")).toBeVisible();
  await expect(unfocusedRow.getByLabel("Yiming Hu Human online")).toHaveCount(0);
});
