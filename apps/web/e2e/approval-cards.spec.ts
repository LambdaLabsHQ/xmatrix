import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  fixtureJson,
  fixtureRequestBodies,
  installWorkspaceStubs,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const GRANT_URL = "**/api/xmatrix/spaces/space-personal/cross-space-read-grants/grant-1";

const grant = {
  id: "grant-1",
  spaceId: E2E_SPACE.id,
  ownerUserId: "e2e-user",
  channelId: "channel-release",
  scope: "space",
  status: "pending",
  reason: "Compare this release with the last one",
  agentName: "claude",
  expiresAt: "2026-07-02T00:00:00.000Z",
  readCount: 0,
};

function card(sequence: number, metadata: Record<string, unknown>) {
  return {
    messageId: `message-card-${sequence}`,
    channelId: E2E_CHANNEL.id,
    sequence,
    body: "claude is waiting on a decision.",
    sentAt: E2E_NOW,
    from: {
      identityId: "agent:claude",
      kind: "agent",
      label: "claude",
      userId: "e2e-user",
      email: "claude@xmatrix.test",
      agentName: "claude",
    },
    metadata,
  };
}

const readCard = card(1, {
  crossSpaceRead: { grantId: grant.id, spaceId: grant.spaceId, ownerUserId: grant.ownerUserId, agentName: grant.agentName },
});
const secretCard = card(2, {
  secretRequest: { secretRef: "deploy-token", envName: "DEPLOY_TOKEN", reason: "Deploy the worker", agentName: "claude",
    runId: "run-1", channelId: E2E_CHANNEL.id },
});

/** Opens the Channel on these cards; `pending` is what the Hub lists for the dock. */
async function openCards(page: Page, messages: unknown[], pending: unknown[]) {
  await installWorkspaceStubs(page, {
    spaces: [E2E_SPACE],
    channels: [{ ...E2E_CHANNEL, messageCount: messages.length, lastMessageSequence: messages.length }],
  });
  const stubs: Array<[string, string, unknown, string?]> = [
    ["cards-history", "**/api/xmatrix/channels/channel-general/history**", { messages, hasMore: false }],
    ["cards-pending", "**/api/xmatrix/channels/channel-general/cross-space-read-grants/pending**", { grants: pending }],
    ["cards-grant", GRANT_URL, { grant }],
    ["cards-decision", `${GRANT_URL}/decision`, { grant: { ...grant, status: "approved" } }, "POST"],
    ["cards-secret", "**/api/secret-requests/status", { saved: false, readable: false, canApprove: true }, "POST"],
    ["cards-fulfill", "**/api/secret-requests/fulfill", { saved: true, readable: true, canApprove: true }, "POST"],
  ];
  for (const [id, pattern, json, method] of stubs) await fixtureJson(page, id, pattern, json, { method });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
}

/** What frames an element: any of these makes it a card rather than a piece of the paper. */
function frame(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      shadow: style.boxShadow,
      border: style.borderTopWidth,
      blur: style.backdropFilter,
    };
  });
}

const UNFRAMED = { background: "rgba(0, 0, 0, 0)", shadow: "none", border: "0px", blur: "none" };

test("an approval card is a piece of the paper, and its owner decides on it", async ({ page }) => {
  await openCards(page, [readCard], []);
  const approval = page.locator('[data-approval-card="open"]');
  await expect(approval.getByRole("heading", { name: "Read another Space" })).toBeVisible();
  await expect(approval.getByText("Waiting for you")).toBeVisible();
  await expect(approval.getByText("the whole Space of Channel channel-release")).toBeVisible();
  expect(await frame(approval)).toEqual(UNFRAMED);

  // The paper's controls: the one primary action is solid ink, the other an ink ring; neither is glass.
  const approve = await frame(approval.getByRole("button", { name: "Approve" }));
  expect(approve).toMatchObject({ shadow: "none", blur: "none" });
  expect(approve.background).not.toBe(UNFRAMED.background);
  const deny = await frame(approval.getByRole("button", { name: "Deny" }));
  expect(deny).toMatchObject({ background: UNFRAMED.background, blur: "none" });
  expect(deny.shadow).not.toBe("none");

  await approval.getByRole("button", { name: "Approve" }).click();
  const settled = page.locator('[data-approval-card="settled"]');
  await expect(settled.getByText("Approved · read-only")).toBeVisible();
  await expect(settled.getByRole("button", { name: "Revoke now" })).toBeVisible();
  expect(await fixtureRequestBodies(page, "cards-decision")).toEqual([{ action: "approve" }]);
});

test("a secret card takes the value on the paper, then leads to the Space's secrets", async ({ page }) => {
  await openCards(page, [secretCard], []);
  const approval = page.locator('[data-approval-card="open"]');
  await expect(approval.getByRole("heading", { name: "Secret for claude" })).toBeVisible();
  await expect(approval.getByText("Waiting for the value")).toBeVisible();
  expect(await frame(approval)).toEqual(UNFRAMED);
  const save = approval.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await expect(approval.getByRole("button", { name: "Manage" })).toBeVisible();

  const value = approval.getByLabel("Value for secret deploy-token");
  expect(await frame(value)).toMatchObject({ background: UNFRAMED.background, blur: "none" });
  await value.fill("s3cret");
  await save.click();

  await expect(page.locator('[data-approval-card="settled"]').getByText("In use")).toBeVisible();
  expect(await fixtureRequestBodies(page, "cards-fulfill")).toEqual([
    { ...secretCard.metadata.secretRequest, messageId: secretCard.messageId, value: "s3cret" },
  ]);

  // Whoever may answer the card can go on to edit, rotate or delete the secret.
  await page.locator('[data-approval-card="settled"]').getByRole("button", { name: "Manage" }).click();
  await expect(page).toHaveURL(/\/settings\?item=secrets$/);
  await expect(page.getByRole("heading", { name: "Secrets", level: 2 })).toBeVisible();
});

test("the Pending approvals dock is one white sheet holding unframed cards, and folds to a line each", async ({ page }) => {
  await openCards(page, [readCard], [grant]);
  const dock = page.getByRole("region", { name: "Pending approvals" });
  const docked = dock.locator('[data-approval-card="open"]');
  await expect(docked.getByRole("button", { name: "Approve" })).toBeVisible();
  expect(await frame(docked)).toEqual(UNFRAMED);
  const sheet = await frame(dock);
  expect(sheet.background).not.toBe(UNFRAMED.background);
  expect(sheet.blur).toBe("none");

  const fold = dock.getByRole("button", { name: "Hide" });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await expect(docked).toHaveCount(0);
  await expect(dock.getByText("read another Space")).toBeVisible();
  await expect(dock.getByRole("button", { name: "Show" })).toHaveAttribute("aria-expanded", "false");
});
