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

const accessCard = card(3, {
  secretAccessRequest: { secretRefs: ["deploy-token", "CONNECTOR_SENTRY_E2E_WEBHOOK_SIGNING_SECRET"],
    reason: "Deploys run every hour", agentName: "claude",
    runId: "run-1", channelId: E2E_CHANNEL.id },
});

/** What the Hub says of a secret card before and after it is answered. */
const VALUE_ASKED = {
  status: { saved: false, readable: false, canApprove: true } as unknown,
  fulfilled: { saved: true, readable: true, canApprove: true } as unknown,
};
const ACCESS_REFS = accessCard.metadata.secretAccessRequest.secretRefs;
const ACCESS_ASKED = {
  status: { canApprove: true, secrets: ACCESS_REFS.map((secretRef) => ({ secretRef, access: "ask" })) },
  fulfilled: { canApprove: true, secrets: ACCESS_REFS.map((secretRef) => ({ secretRef, access: "auto" })) },
};

/** Opens the Channel on these cards; `pending` is what the Hub lists for the dock. */
async function openCards(page: Page, messages: unknown[], pending: unknown[], secret = VALUE_ASKED) {
  await installWorkspaceStubs(page, {
    spaces: [E2E_SPACE],
    channels: [{ ...E2E_CHANNEL, messageCount: messages.length, lastMessageSequence: messages.length }],
  });
  const stubs: Array<[string, string, unknown, string?]> = [
    ["cards-history", "**/api/xmatrix/channels/channel-general/history**", { messages, hasMore: false }],
    ["cards-pending", "**/api/xmatrix/channels/channel-general/cross-space-read-grants/pending**", { grants: pending }],
    ["cards-grant", GRANT_URL, { grant }],
    ["cards-decision", `${GRANT_URL}/decision`, { grant: { ...grant, status: "approved" } }, "POST"],
    ["cards-secret", "**/api/secret-requests/status", secret.status, "POST"],
    ["cards-fulfill", "**/api/secret-requests/fulfill", secret.fulfilled, "POST"],
  ];
  for (const [id, pattern, json, method] of stubs) await fixtureJson(page, id, pattern, json, { method });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
}

/** What frames an element: its ground, edge, corner and whether it is glass. */
function frame(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      shadow: style.boxShadow,
      border: style.borderTopWidth,
      blur: style.backdropFilter,
      radius: style.borderTopLeftRadius,
    };
  });
}

/**
 * A card on the paper is one flat block of colour with a notice's corners: no edge, no shadow, no glass.
 * Its first line is its heading, the question, so the largest type is where reading starts.
 */
async function expectColourBlock(card: Locator, firstLine = "H3") {
  const drawn = await frame(card);
  expect(drawn).toMatchObject({ shadow: "none", border: "0px", blur: "none", radius: "10px" });
  expect(drawn.background).not.toBe(UNFRAMED.background);
  expect(await card.evaluate((element) => element.firstElementChild?.tagName)).toBe(firstLine);
  return drawn.background;
}

function inkOf(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).color);
}

const UNFRAMED = { background: "rgba(0, 0, 0, 0)", shadow: "none", border: "0px", blur: "none" };
const PLAIN = { background: UNFRAMED.background, blur: UNFRAMED.blur };

test("an approval card asks its question on a block of colour, and its owner decides on it", async ({ page }) => {
  await openCards(page, [readCard], []);
  const approval = page.locator('[data-ask-card="open"]');
  // It reads as an ask: who asks in brass, then the question as the card's heading.
  await expect(approval.getByRole("heading", { name: "Let claude read another Space?" })).toBeVisible();
  await expect(approval.getByText("The whole Space of Channel channel-release")).toBeVisible();
  const asking = await inkOf(approval.getByText("claude asks · Read access"));
  const waiting = await expectColourBlock(approval);

  // The paper's controls: the one primary action is solid ink, the other an ink ring; neither is glass.
  const approve = await frame(approval.getByRole("button", { name: "Approve" }));
  expect(approve).toMatchObject({ shadow: "none", blur: "none" });
  expect(approve.background).not.toBe(UNFRAMED.background);
  const deny = await frame(approval.getByRole("button", { name: "Deny" }));
  expect(deny).toMatchObject(PLAIN);
  expect(deny.shadow).not.toBe("none");

  await approval.getByRole("button", { name: "Approve" }).click();
  const settled = page.locator('[data-ask-card="settled"]');
  await expect(settled.getByText("Approved · read-only")).toBeVisible();
  // Answered, the brass leaves both the block and the line saying who asked.
  expect(await inkOf(settled.getByText("claude asks · Read access"))).not.toBe(asking);
  expect(await expectColourBlock(settled)).not.toBe(waiting);
  await expect(settled.getByRole("button", { name: "Revoke now" })).toBeVisible();
  expect(await fixtureRequestBodies(page, "cards-decision")).toEqual([{ action: "approve" }]);
});

test("a secret card takes the value on the paper, then leads to the Space's secrets", async ({ page }) => {
  await openCards(page, [secretCard], []);
  const approval = page.locator('[data-ask-card="open"]');
  await expect(approval.getByRole("heading", { name: "Give claude the secret deploy-token?" })).toBeVisible();
  await expect(approval.getByText("claude asks · Secret")).toBeVisible();
  await expectColourBlock(approval);
  const save = approval.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await expect(approval.getByRole("button", { name: "Manage" })).toBeVisible();

  const value = approval.getByLabel("Value for secret deploy-token");
  expect(await frame(value)).toMatchObject(PLAIN);
  await value.fill("s3cret");
  await save.click();

  await expect(page.locator('[data-ask-card="settled"]').getByText("In use")).toBeVisible();
  expect(await fixtureRequestBodies(page, "cards-fulfill")).toEqual([
    { ...secretCard.metadata.secretRequest, messageId: secretCard.messageId, value: "s3cret" },
  ]);

  // Whoever may answer the card can go on to edit, rotate or delete the secret.
  await page.locator('[data-ask-card="settled"]').getByRole("button", { name: "Manage" }).click();
  await expect(page).toHaveURL(/\/settings\?item=secrets$/);
  await expect(page.getByRole("heading", { name: "Secrets", level: 2 })).toBeVisible();
});

test("a card asking that secrets be read without asking is answered once, for the ticked ones", async ({ page }) => {
  await openCards(page, [accessCard], [], ACCESS_ASKED);
  const approval = page.locator('[data-ask-card="open"]');
  await expect(approval.getByRole("heading", { name: "Let Agents read these 2 secrets without asking?" })).toBeVisible();
  await expect(approval.getByText("claude asks · Secret access")).toBeVisible();
  await expectColourBlock(approval);
  // While it waits, each name is whole, however long, beside its own tick.
  for (const ref of ACCESS_REFS) await expect(approval.getByLabel(`Read ${ref} without asking`)).toBeChecked();
  // A tick is the card's ink, not the browser's blue.
  expect(await approval.getByRole("checkbox").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return style.accentColor === style.color;
  })).toBe(true);
  const longName = approval.getByText(ACCESS_REFS[1], { exact: true });
  expect(await longName.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await approval.getByLabel(`Read ${ACCESS_REFS[1]} without asking`).uncheck();

  await approval.getByRole("button", { name: "Let Agents read it without asking" }).click();
  const settled = page.locator('[data-ask-card="settled"]');
  await expect(settled.getByText("Automatic", { exact: true })).toBeVisible();
  await expect(settled.getByRole("button", { name: "Manage" })).toBeVisible();
  expect(await fixtureRequestBodies(page, "cards-fulfill")).toEqual([
    { runId: "run-1", channelId: E2E_CHANNEL.id, secretRefs: ["deploy-token"], messageId: accessCard.messageId },
  ]);
  // Answered, the names fold to one line and open again on request.
  await expect(settled.getByRole("checkbox")).toHaveCount(0);
  await expect(settled.getByText(ACCESS_REFS[1], { exact: true })).toBeHidden();
  await settled.getByText("2 secrets", { exact: true }).click();
  await expect(settled.getByText(ACCESS_REFS[1], { exact: true })).toBeVisible();
});

test("the Pending approvals dock is one block of colour, its asks unframed inside it, and folds to a line each", async ({ page }) => {
  await openCards(page, [readCard], [grant]);
  const dock = page.getByRole("region", { name: "Pending approvals" });
  const docked = dock.locator('[data-ask-card="open"]');
  await expect(docked.getByRole("button", { name: "Approve" })).toBeVisible();
  expect(await frame(docked)).toMatchObject(UNFRAMED);
  // The dock is the block here, in the colour an ask has in the stream, with the asks as its lines.
  const inStream = page.locator('[data-ask-card="open"]:not(.app-channel-approvals *)');
  // The dock's own first line is its section label; each ask under it still starts with its question.
  expect(await expectColourBlock(dock, "DIV")).toBe(await expectColourBlock(inStream));
  expect(await docked.evaluate((element) => element.firstElementChild?.tagName)).toBe("H3");

  const fold = dock.getByRole("button", { name: "Hide" });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await expect(docked).toHaveCount(0);
  await expect(dock.getByText("read another Space")).toBeVisible();
  await expect(dock.getByRole("button", { name: "Show" })).toHaveAttribute("aria-expanded", "false");
});
