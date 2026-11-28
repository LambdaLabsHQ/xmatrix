import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_SPACE, installWorkspaceStubs } from "./workspace-fixtures";

/**
 * The Overview (docs/design/pages-overview.md): the Pages area's first entry and, on a desktop, where it
 * lands. What waits on the reader is answered where it stands, a problem is checked off, what merely
 * happened is read, and leaving records how far the reader has seen.
 */

const page = (pageId: string, title: string, position: string) => ({ pageId, parentPageId: null, title, position,
  accessMode: "open", headRevision: 3, agentSuggestOnly: false, canEdit: true, updatedAt: new Date().toISOString(),
  publishedAt: null, summary: { text: `${title} stands`, revision: 3, at: new Date().toISOString() } });
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const result = (pageId: string, title: string, revision: number, kind: string, text: string, minutes: number, block?: string) => ({
  pageId, title, revision, kind, text, block: block ? { id: block.toLowerCase(), title: block } : null, createdAt: ago(minutes),
  authors: [{ kind: "agent", id: "i-1", label: "codex:2" }], conversationIds: [] });

const waiting = { ...E2E_CHANNEL, id: "channel-waiting", name: "design", messageCount: 5, historyHeadSequence: 5, readSequence: 0,
  attention: { channelId: "channel-waiting", unreadAttentionCount: 1, lastMessageId: "waiting-mention", lastMessageSequence: 3,
    primaryTriggerKind: "mention", triggerKinds: ["mention"], updatedAt: E2E_CHANNEL.updatedAt,
    lastMessage: { messageId: "waiting-mention", from: { kind: "agent", label: "claude:3" },
      bodyPreview: "Which headline ships?", sentAt: ago(30) } } };

const OVERVIEW = {
  seenAt: ago(600),
  results: [
    result("p-relay", "Relay", 9, "shipped", "Search is on beta", 20, "Status"),
    result("p-relay", "Relay", 8, "problem", "Import fails on files over 10 MB", 45, "Risks"),
    result("p-plan", "Plan", 4, "decided", "Pricing stays monthly", 90),
    result("p-plan", "Plan", 2, "number", "Sign-ups rose from 40 to 55", 60 * 30),
  ],
  handled: [],
};
const REQUEST = { channelId: E2E_CHANNEL.id, messageId: "norn:r1abcdef:1", deliveredAt: ago(120), pageId: "p-plan", pageName: "Plan",
  card: { ref: "r1abcdef", verb: "choose", holder: "@Tester", holderUserId: "e2e-user", text: "Publish the changelog today?",
    about: null, context: null, options: ["Hold", "PublishNow"], by: null, asker: "claude:1", otherwise: null, delegatedBy: null } };

async function stubOverview(browser: Page, options: { overview?: unknown; requests?: unknown[] } = {}) {
  await installWorkspaceStubs(browser, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL, waiting] });
  await fixtureJson(browser, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u,
    { pages: [page("p-relay", "Relay", "A"), page("p-plan", "Plan", "B")] });
  await fixtureJson(browser, "page-overview", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/overview$/u, options.overview ?? OVERVIEW,
    { method: "GET" });
  await fixtureJson(browser, "waiting-requests", /\/api\/xmatrix\/spaces\/[^/]+\/norn-requests$/u,
    { requests: options.requests ?? [REQUEST] });
  await fixtureJson(browser, "request-answer", /\/api\/xmatrix\/channels\/[^/]+\/norn-requests\/[^/]+\/answer$/u,
    { status: "running" }, { method: "POST" });
  await fixtureJson(browser, "overview-handled", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/overview\/handled$/u, { handled: true },
    { method: "PUT" });
  await fixtureJson(browser, "overview-seen", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/overview\/seen$/u, { seenAt: ago(0) },
    { method: "PUT" });
}

/** A desktop's Pages area with things to handle: it lands on the Overview. */
async function openDesktopPages(browser: Page) {
  await browser.setViewportSize({ width: 1440, height: 900 });
  await stubOverview(browser);
  await browser.goto("/app", { waitUntil: "domcontentloaded" });
  await browser.getByRole("button", { name: "Pages", exact: true }).first().click();
}

test.describe("on a desktop", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("the Pages area lands on the Overview, where what waits is answered and a problem checked off", async ({ page: browser }) => {
    await openDesktopPages(browser);

    // Its row leads the list, where Recent changes stood: taller than a page's row, not a card, counting what is left.
    const tree = browser.getByTestId("page-tree");
    const row = tree.getByTestId("page-overview-row");
    await expect(row).toContainText("Overview");
    await expect(tree.getByTestId("page-overview-left")).toHaveText("3");
    await expect(row).toContainText("2 need you · 1 problem");
    await expect(tree).not.toContainText("Recent changes");
    const [rowBox, pageBox] = await Promise.all([row.boundingBox(), tree.locator(".app-page-row").first().boundingBox()]);
    expect(rowBox!.height).toBeGreaterThanOrEqual(84);
    expect(rowBox!.height).toBeGreaterThan(pageBox!.height + 20);
    expect(rowBox!.width, "it runs the list's width like any row").toBeCloseTo(pageBox!.width, 0);
    await expect(row).toHaveCSS("border-radius", "0px");

    // The view is a board, not a page: no title line, no editor; what to handle beside what happened.
    const view = browser.getByTestId("pages-overview");
    await expect(view).toBeVisible();
    await expect(browser.getByTestId("page-editor")).toHaveCount(0);
    await expect(view.getByTestId("overview-left")).toHaveText("3to handle");
    const [todo, happened] = await Promise.all([view.getByTestId("overview-todo").boundingBox(),
      view.getByTestId("overview-happened").boundingBox()]);
    expect(happened!.x, "what happened stands beside what to handle").toBeGreaterThan(todo!.x + todo!.width - 1);
    await expect(view.getByTestId("overview-request")).toContainText("Publish the changelog today?");
    await expect(view.getByTestId("overview-wait")).toContainText("Which headline ships?");
    await expect(view.getByTestId("overview-problem")).toContainText("Import fails on files over 10 MB");
    // Since the reader last looked: the old number is not listed until the range is the week.
    await expect(view.getByTestId("overview-result")).toHaveText([/Search is on beta/u, /Pricing stays monthly/u]);
    await browser.screenshot({ path: test.info().outputPath("overview-desktop.png") });

    // A request is answered on its own row, with the option as the program wrote it.
    await view.getByTestId("overview-request").getByRole("button", { name: "Hold" }).click();
    await expect.poll(async () => await fixtureRequestBodies(browser, "request-answer")).toEqual([{ outcome: "answered", text: "Hold" }]);
    await expect(view.getByTestId("overview-receipt").first()).toContainText("You answered Hold");
    await expect(view.getByTestId("overview-left"), "handled here, it no longer counts as left").toHaveText("2to handle");
    await expect(view.getByTestId("overview-strip")).toContainText("1 handled");

    // A problem that needs nothing is checked off, and the Hub hears which result that was.
    await view.getByTestId("overview-problem").getByRole("button", { name: "Got it" }).click();
    await expect.poll(async () => await fixtureRequestBodies(browser, "overview-handled")).toEqual([{ pageId: "p-relay", revision: 8 }]);
    await expect(view.getByTestId("overview-receipt").last()).toHaveText("Got it");
    await expect(view.getByTestId("overview-left")).toHaveText("1to handle");
    // What waits in a conversation is marked done from here too, and then nothing is left.
    await view.getByTestId("overview-wait").getByRole("button", { name: "Done" }).click();
    await expect(view.getByTestId("overview-receipt")).toHaveCount(3);
    await expect(view.getByTestId("overview-strip")).toContainText("All caught up");
    await expect(view.getByTestId("overview-strip")).toContainText("3 handled");

    // The range is a segmented control over what happened; the week has the older number too.
    await expect(view.getByRole("tab", { name: "New", exact: true })).toHaveAttribute("aria-selected", "true");
    const [tabs, column] = await Promise.all([view.getByRole("tablist").boundingBox(), view.getByTestId("overview-happened").boundingBox()]);
    expect(tabs!.x + tabs!.width, "all four ranges stand inside the column").toBeLessThanOrEqual(column!.x + column!.width + 0.5);
    expect(await view.getByRole("tablist").evaluate((track) => track.scrollWidth <= track.clientWidth), "none is cut off").toBe(true);
    await view.getByRole("tab", { name: "Week", exact: true }).click();
    await expect(view.getByTestId("overview-result")).toHaveCount(3);
    await expect(view.getByTestId("overview-result").last()).toContainText("Sign-ups rose from 40 to 55");

    // Turning away from the tab records how far was seen, and what was new stays listed for the rest of the visit.
    const turn = (state: string) => browser.evaluate((visibility) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
    await turn("hidden");
    await expect.poll(async () => await fixtureRequestBodies(browser, "overview-seen"))
      .toEqual([{ through: OVERVIEW.results[0]!.createdAt }]);
    await turn("visible");
    await view.getByRole("tab", { name: "New", exact: true }).click();
    await expect(view.getByTestId("overview-result")).toHaveCount(2);

    // A result opens its page at the section it is in. Leaving says nothing again: nothing newer was shown.
    await view.getByTestId("overview-result").first().click();
    await expect(browser).toHaveURL(/page=p-relay/u);
    await expect(view).toHaveCount(0);
    expect(await fixtureRequestBodies(browser, "overview-seen")).toHaveLength(1);
  });

  test("leaving the Overview records how far its reader has seen", async ({ page: browser }) => {
    await openDesktopPages(browser);
    await expect(browser.getByTestId("pages-overview").getByTestId("overview-result")).toHaveCount(2);
    expect(await fixtureRequestBodies(browser, "overview-seen")).toHaveLength(0);
    await browser.getByTestId("page-tree").locator(".app-page-row-title").first().click();
    await expect.poll(async () => await fixtureRequestBodies(browser, "overview-seen"))
      .toEqual([{ through: OVERVIEW.results[0]!.createdAt }]);
  });

  test("with nothing left, the row shows a check and the board says so", async ({ page: browser }) => {
    await browser.setViewportSize({ width: 1440, height: 900 });
    await installWorkspaceStubs(browser, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
    await fixtureJson(browser, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u, { pages: [page("p-relay", "Relay", "A")] });
    await browser.goto("/app", { waitUntil: "domcontentloaded" });
    await browser.getByRole("button", { name: "Pages", exact: true }).first().click();
    const row = browser.getByTestId("page-tree").getByTestId("page-overview-row");
    await expect(row).toContainText("All caught up");
    await expect(browser.getByTestId("page-tree").getByTestId("page-overview-left")).toHaveCount(0);
    await expect(browser.getByTestId("page-tree")).toContainText("Up to date");
    const view = browser.getByTestId("pages-overview");
    await expect(view.getByTestId("overview-clear")).toContainText("Nothing left to handle.");
    await expect(view.getByTestId("overview-strip")).toContainText("All caught up");
    await expect(view.getByTestId("overview-happened")).toContainText("Nothing in this range.");
    // A page is still one click away, and the Overview's row gives the selection back.
    await browser.getByTestId("page-tree").locator(".app-page-row-title").first().click();
    await expect(browser).toHaveURL(/page=p-relay/u);
    await expect(row).not.toHaveClass(/app-page-row-selected/u);
    await row.click();
    await expect(browser).toHaveURL(/page=overview/u);
    await expect(view).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("the Overview's row leads the Pages list and opens as a pushed screen", async ({ page: browser }) => {
    await stubOverview(browser);
    await browser.goto("/app", { waitUntil: "domcontentloaded" });
    await browser.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Pages" }).tap();
    const list = browser.getByTestId("page-list");
    const row = list.getByTestId("page-overview-row");
    await expect(row).toContainText("2 need you · 1 problem");
    await expect(list.getByTestId("page-overview-left")).toHaveText("3");
    const [rowBox, firstPage] = await Promise.all([row.boundingBox(), list.locator(".app-page-row").first().boundingBox()]);
    expect(rowBox!.y, "above the pages").toBeLessThan(firstPage!.y);
    expect(rowBox!.height).toBeGreaterThanOrEqual(84);
    await expect(browser.getByTestId("pages-overview"), "a phone starts from the list").toHaveCount(0);

    await row.tap();
    const view = browser.getByTestId("pages-overview");
    await expect(view).toBeVisible();
    await expect(browser.locator(".app-mobile-bar-title")).toHaveText("Overview");
    await expect(view.getByTestId("overview-left")).toHaveText("3to handle");
    // One column: what happened comes under what to handle.
    const [todo, happened] = await Promise.all([view.getByTestId("overview-todo").boundingBox(),
      view.getByTestId("overview-happened").boundingBox()]);
    expect(happened!.y).toBeGreaterThan(todo!.y + todo!.height - 1);
    expect(Math.abs(happened!.x - todo!.x)).toBeLessThanOrEqual(1);
    await browser.screenshot({ path: test.info().outputPath("overview-phone.png") });
    await browser.getByRole("button", { name: "Back to pages" }).tap();
    await expect(view).toHaveCount(0);
    await expect(row).toBeVisible();
  });
});
