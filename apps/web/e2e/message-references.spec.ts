import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_USER_SENDER, installWorkspaceStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const NOW = "2026-10-03T12:00:00.000Z";
const RELEASE = { ...E2E_CHANNEL, id: "5f0c2d4e-8a1b-4c3d-9e2f-1a2b3c4d5e6f", name: "release-train",
  topic: "Where trains ship" };
const PAGE_ID = "0b7c2a1e-4f3d-4c2b-9a8e-1d2c3b4a5f6e";
const RELAY = { pageId: PAGE_ID, parentPageId: null, title: "Relay", position: "V", accessMode: "open",
  headRevision: 6, agentSuggestOnly: false, canEdit: true, updatedAt: NOW };
const BODY = "# Relay\n\n## Status\n\nIn progress\n\n## Notes\n\n**none**\n";

type Page = Parameters<Parameters<typeof test>[2]>[0]["page"];

async function stubReferences(browser: Page, messages: unknown[] = []) {
  await installWorkspaceStubs(browser, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL, RELEASE] });
  await fixtureJson(browser, "general-history", "**/api/xmatrix/channels/channel-general/history**",
    { messages, hasMore: false });
  await fixtureJson(browser, "conversation-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?conversationId=/u,
    { links: [] });
  await fixtureJson(browser, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u, { pages: [RELAY] });
  await fixtureJson(browser, "page-doc", new RegExp(`/api/xmatrix/spaces/[^/]+/pages/${PAGE_ID}$`, "u"), {
    page: { ...RELAY, body: BODY, mounts: [], revisionInfo: { revision: 6, kind: "edit", authors: [],
      conversationIds: [], basedOnRevision: 5, createdAt: NOW } },
  });
}

test("# and [[ pick channels, pages and sections by name, and the message carries their ids", async ({ page: browser }) => {
  await stubReferences(browser);
  await fixtureJson(browser, "send", "**/api/xmatrix/channels/channel-general/messages",
    { message: { id: "sent-id" } }, { method: "POST" });
  await browser.goto("/app/personal-sspaceperso/channels/channel-general", { waitUntil: "domcontentloaded" });
  const draft = browser.locator("textarea.composer-textarea").first();
  const suggestions = browser.getByTestId("composer-reference-suggestions");

  await draft.fill("ship in #rel");
  await expect(suggestions.getByRole("option", { name: /release-train/u })).toBeVisible();
  await expect(suggestions).toContainText("Where trains ship");
  await draft.press("Enter");
  await expect(draft).toHaveValue("ship in #release-train ");

  await draft.pressSequentially("per [[Rel");
  await expect(suggestions.getByRole("option", { name: /Relay/u })).toBeVisible();
  await draft.press("Enter");
  await expect(draft).toHaveValue("ship in #release-train per [[Relay]] ");

  // A Chinese input method types 【【; # inside it lists the page's sections.
  await draft.pressSequentially("和【【Relay#sta");
  await expect(suggestions).toContainText("Sections");
  await expect(suggestions.getByRole("option", { name: /Status/u })).toBeVisible();
  await draft.press("Enter");
  await expect(draft).toHaveValue("ship in #release-train per [[Relay]] 和[[Relay#Status]] ");

  // A pull request number stays text.
  await draft.pressSequentially("#3484");
  await expect(suggestions).toHaveCount(0);

  await draft.press("Enter");
  await expect.poll(async () => (await fixtureRequestBodies(browser, "send")).length).toBe(1);
  const [sent] = await fixtureRequestBodies(browser, "send") as Array<{ body: string }>;
  expect(sent!.body).toBe(`ship in channel:${RELEASE.id} per page:${PAGE_ID} 和page:${PAGE_ID}#status #3484`);
});

test("channel: and page: references render as chips that open their targets", async ({ page: browser }) => {
  await stubReferences(browser, [{
    messageId: "m-refs", channelId: E2E_CHANNEL.id, sequence: 1,
    body: `Moved to channel:${RELEASE.id}, see page:${PAGE_ID}#notes; ` +
      "old thread channel:9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a.",
    from: E2E_USER_SENDER, sentAt: NOW,
  }]);
  await browser.goto("/app/personal-sspaceperso/channels/channel-general", { waitUntil: "domcontentloaded" });

  const channels = browser.getByTestId("channel-reference-chip");
  await expect(channels).toHaveCount(2);
  await expect(channels.nth(0)).toContainText("release-train");
  // A channel the reader cannot see names nothing about it.
  await expect(channels.nth(1)).toHaveText("private channel");
  await expect(channels.nth(1)).not.toHaveAttribute("role", "button");

  const section = browser.getByTestId("page-reference-chip");
  await expect(section).toContainText("Relay › Notes");
  await section.hover();
  await expect(browser.getByTestId("page-reference-preview")).toContainText("none");
  await expect(browser.getByTestId("page-reference-preview").locator("strong")).toHaveText("none");

  await channels.nth(0).hover();
  await expect(browser.getByTestId("channel-reference-preview")).toContainText("Where trains ship");
  await channels.nth(0).click();
  await expect(browser).toHaveURL(/release-train/u);

  await browser.goBack();
  await browser.getByTestId("page-reference-chip").click();
  await expect(browser.getByTestId("pages-view")).toBeVisible();
  await expect(browser).toHaveURL(new RegExp(`/pages\\?page=${PAGE_ID}`, "u"));
});
