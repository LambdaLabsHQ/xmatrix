import { test, expect } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_SPACE, E2E_USER_SENDER, fixtureJson, fixtureRule, releaseFixture, installWorkspaceStubs } from "./workspace-fixtures";

const PAGE = { pageId: "p-plan", parentPageId: null, title: "Bali plan", position: "V", accessMode: "open",
  headRevision: 4, agentSuggestOnly: false, canEdit: true, updatedAt: E2E_NOW };
const BEFORE = "# Bali plan\n\n## Itinerary\n\nLeave on 3 November.\n\n## Budget\n\nTo be decided.\n";
const AFTER = "# Bali plan\n\n## Itinerary\n\nLeave on 3 November from Shanghai on GA 859.\n\n## Budget\n\n" +
  "## Stay\n\nTwo weeks in Ubud, then Canggu.\n";
const AGENT = { kind: "agent", identityId: "agent:channel-general:1", agentId: "channel-general:1", userId: "e2e-user",
  email: "", label: "claude", agentName: "claude", instanceId: "channel-general:1", channelInstanceId: "1",
  instanceLabel: "claude" };

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

for (const first of ["bookmark", "edit card"] as const) test(`page edits and bookmarks share revisions (${first} loads first), with a way back`, async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [{ ...E2E_CHANNEL, messageCount: 2, historyHeadSequence: 2 }] });
  await fixtureJson(page, "edit-history", "**/api/xmatrix/channels/channel-general/history**", { messages: [
    { messageId: "asked", channelId: E2E_CHANNEL.id, sequence: 1, body: "Draft the plan from my mail", sentAt: E2E_NOW,
      from: E2E_USER_SENDER },
    { messageId: "reply", channelId: E2E_CHANNEL.id, sequence: 2, body: "Wrote the outline into the page.",
      sentAt: E2E_NOW, from: AGENT },
  ], hasMore: false });
  await fixtureJson(page, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u, { pages: [PAGE] });
  // Both surfaces read the same historical revisions. Their shared cache must retain complete documents.
  await fixtureJson(page, "conversation-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?conversationId=/u,
    { links: [{ linkId: "l-plan", conversationId: E2E_CHANNEL.id, pageId: PAGE.pageId, blockId: "itinerary",
      source: "edit", createdAt: E2E_NOW, lastSeenAt: E2E_NOW }] });
  await fixtureJson(page, "current-page", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-plan$/u,
    { page: { ...PAGE, body: `${AFTER}\n## Notes\n\nReady.\n`,
      revisionInfo: { revision: 4, kind: "edit", authors: [], conversationIds: [], createdAt: E2E_NOW } } });
  await fixtureRule(page, { id: "awareness", pattern: /\/pages\/p-plan\/awareness(?:\?.*)?$/u,
    responder: { kind: first === "edit card" ? "deferred" : "static", json: {
      pageId: PAGE.pageId, headRevision: 4, blocks: [{ blockId: "itinerary", updated: {
        revision: 3, authors: [{ kind: "agent", id: "a1", label: "claude" }],
        conversationIds: [E2E_CHANNEL.id], createdAt: E2E_NOW } }] } } });
  await fixtureRule(page, { id: "page-edits", pattern: "**/api/xmatrix/channels/channel-general/page-edits/query",
    method: "POST", responder: { kind: first === "bookmark" ? "deferred" : "static", json: { edits: [
    { messageId: "reply", pageId: "p-plan", title: "Bali plan",
      revisions: [{ revision: 2, basedOnRevision: 1 }, { revision: 3, basedOnRevision: 2 }] },
  ] } } });
  for (const [revision, body] of [[1, BEFORE], [2, BEFORE], [3, AFTER]] as const) {
    await fixtureJson(page, `revision-${revision}`, new RegExp(`/api/xmatrix/spaces/[^/]+/pages/p-plan\\?revision=${revision}$`, "u"),
      { page: { ...PAGE, body, revisionInfo: { revision, basedOnRevision: revision - 1, kind: "edit", authors: [], conversationIds: [], createdAt: E2E_NOW } } });
  }
  await page.goto("/app/personal-sspaceperso/channels/channel-general");

  const card = page.getByTestId("page-edit-card");
  const bookmark = page.getByTestId("conversation-page-cards");
  if (first === "bookmark") {
    await expect(bookmark).toContainText("claude");
    await expect(bookmark).toContainText("Leave on 3 November from Shanghai on GA 859.");
    await releaseFixture(page, "page-edits");
  } else {
    await expect(card).toContainText("3 changes");
    await releaseFixture(page, "awareness");
  }
  await expect(bookmark).toContainText("claude");
  await expect(bookmark).toContainText("Leave on 3 November from Shanghai on GA 859.");
  await expect(card).toContainText("Bali plan");
  await expect(card).toContainText("3 changes");
  // Each changed line where it stands: new words underlined, words taken out struck through.
  await expect(card.locator("ins").first()).toHaveText(" from Shanghai on GA 859");
  await expect(card.locator("del")).toHaveText("To be decided.");
  await expect(card.locator(".app-page-edit-line[data-kind=added]")).toContainText("Two weeks in Ubud, then Canggu.");
  // A person's message changed nothing, so only the Agent's reply carries a card.
  await expect(card).toHaveCount(1);
  await expect(page.locator(".app-message-row", { hasText: "Wrote the outline" }).getByTestId("page-edit-card")).toBeVisible();

  await card.click();
  const back = page.getByTestId("page-back-to-message");
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(/channel-general/u);
  await expect(page.locator(".app-message-row", { hasText: "Wrote the outline" })).toBeVisible();
});
