import { encodePageSync } from "../src/lib/pages/page-sync-codec";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";
import { editPageMarkdown, pageDocument, pageMarkdown } from "./page-document-fixture";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_USER_SENDER, installWorkspaceStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const NOW = "2026-09-26T12:00:00.000Z";
const page = (pageId: string, parentPageId: string | null, title: string, position: string) => ({
  pageId, parentPageId, title, position, accessMode: "open", headRevision: 3, agentSuggestOnly: false,
  canEdit: true, updatedAt: NOW,
});
const BODY = "# Relay\n\n## Status\n\nIn progress\n\n## Notes\n\nnone\n";

type Page = Parameters<Parameters<typeof test>[2]>[0]["page"];

/** The page tree and live-session ticket for one Space's pages. */
async function stubPages(browser: Page, pages: ReturnType<typeof page>[], channels: unknown[] = [E2E_CHANNEL]) {
  await installWorkspaceStubs(browser, { spaces: [E2E_SPACE], channels });
  await fixtureJson(browser, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u, { pages });
  await fixtureJson(browser, "page-live", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/[^/]+\/live$/u, {
    protocol: "xmatrix-page-v2.ticket", socketPath: "/ws/pages/space-personal/p-relay", canEdit: true, headRevision: 3,
  });
  await fixtureJson(browser, "page-claims", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/[^/]+\/claims$/u, {
    claims: [], competitiveBlocks: [],
  });
  await fixtureJson(browser, "page-awareness", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/[^/]+\/awareness$/u, {
    pageId: "p-relay", headRevision: 3, blocks: [],
  });
  await fixtureJson(browser, "page-automations", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/[^/]+\/automations$/u, {
    automations: [],
  });
  // This reader has read every page to its head, so nothing shows as changed unless a test says so.
  await fixtureJson(browser, "page-read", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/[^/]+\/read$/u, { revision: 3 });
  // Each page's document as read over HTTP, before its live session syncs.
  for (const item of pages) {
    await fixtureJson(browser, `page-document-${item.pageId}`,
      new RegExp(`/api/xmatrix/spaces/[^/]+/pages/${item.pageId}$`, "u"), { page: { ...item, body: BODY,
        revisionInfo: { revision: 3, kind: "edit", authors: [], conversationIds: [], createdAt: NOW } } });
  }
}

/**
 * A stand-in for the page's session object: the same Yjs sync protocol over
 * the page socket, relaying edits and awareness between everyone connected,
 * as the session does. Its `connect` hands a test the socket's send, to push more.
 */
const sessionSockets = new WeakMap<Y.Doc, Set<(data: Uint8Array, from: object) => void>>();
async function servePageSession(browser: Page, server: Y.Doc,
  on: { connect?: (send: (data: Uint8Array) => void) => void; clientUpdate?: () => void; syncAfterMs?: number } = {}) {
  const peers = sessionSockets.get(server) ?? new Set();
  sessionSockets.set(server, peers);
  await browser.routeWebSocket(/\/ws\/pages\//u, async (socket) => {
    const self = {};
    const send = (data: Uint8Array) => socket.send(Buffer.from(data));
    const relay = (data: Uint8Array, from: object) => { if (from !== self) send(data); };
    if (on.syncAfterMs) await new Promise((resolve) => setTimeout(resolve, on.syncAfterMs));
    send(encodePageSync(encoder => syncProtocol.writeSyncStep1(encoder, server)));
    const notice = encoding.createEncoder();
    encoding.writeVarUint(notice, 2);
    encoding.writeVarString(notice, JSON.stringify({ type: "session", headRevision: 3, canEdit: true }));
    send(encoding.toUint8Array(notice));
    peers.add(relay);
    socket.onMessage((message) => {
      if (typeof message === "string") return;
      const data = new Uint8Array(message);
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      // Awareness (cursors, who is where) goes to everyone else as it came.
      if (type === 1) for (const peer of peers) peer(data, self);
      if (type !== 0) return;
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, 0);
      if (syncProtocol.readSyncMessage(decoder, reply, server, self) === syncProtocol.messageYjsUpdate) {
        on.clientUpdate?.();
      }
      if (encoding.length(reply) > 1) send(encoding.toUint8Array(reply));
    });
    server.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === self) return;
      send(encodePageSync(encoder => syncProtocol.writeUpdate(encoder, update)));
    });
    on.connect?.(send);
  });
}

/** Starting a conversation from a page: the conversation it creates and the link tying it to a section. */
async function stubPageConversation(browser: Page, channel: typeof E2E_CHANNEL, link: { linkId: string; blockId: string }) {
  await fixtureJson(browser, "channel-create", /\/api\/xmatrix\/channels$/u, { channel }, { method: "POST" });
  await fixtureJson(browser, "link-create", /\/api\/xmatrix\/spaces\/[^/]+\/page-links$/u, { link: {
    ...link, conversationId: channel.id, pageId: "p-relay", source: "manual", createdAt: NOW, lastSeenAt: NOW,
    anchor: null, resolvedAt: null } }, { method: "POST" });
}

/** Opens Pages on a page whose live session holds `body`, and returns its editor. */
async function openLivePage(browser: Page, session: Y.Doc | string = BODY) {
  await servePageSession(browser, typeof session === "string" ? pageDocument(session) : session);
  await browser.goto("/app", { waitUntil: "domcontentloaded" });
  await browser.getByRole("button", { name: "Pages", exact: true }).first().click();
  return browser.getByTestId("page-editor");
}

/** Selects the line of the page that holds `text`. */
async function selectLine(browser: Page, text: string) {
  // A triple click selects that paragraph. Home would follow whatever block the caret was already in.
  await browser.getByTestId("page-editor").getByText(text, { exact: true }).click({ clickCount: 3 });
}

test("a page is co-edited live and shows an Agent working on a section it claimed", async ({ page: browser }) => {
  await stubPages(browser, [page("p-company", null, "Company", "V"), page("p-relay", "p-company", "Relay", "V")]);
  await fixtureJson(browser, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, {
    links: [{ linkId: "l1", conversationId: E2E_CHANNEL.id, pageId: "p-relay", blockId: "status", source: "edit",
      createdAt: NOW, lastSeenAt: NOW }],
  });
  await fixtureJson(browser, "page-awareness", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/[^/]+\/awareness$/u, {
    pageId: "p-relay", headRevision: 3, blocks: [{ blockId: "notes", claims: [], present: [], updated: {
      revision: 2, authors: [{ kind: "agent", id: "a1", label: "claude:1" }], conversationIds: [E2E_CHANNEL.id],
      createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() },
      owed: { reason: "merged", at: new Date(Date.now() - 20 * 60_000).toISOString(), holder: "codex:2",
        conversationId: E2E_CHANNEL.id, pullRequestUrl: "https://github.com/o/r/pull/7" } }],
  });
  // An Agent whose live Run read the Notes a while ago is still on the page, though its cursor has lapsed;
  // another works on the Status from a live Run.
  await fixtureJson(browser, "page-agents", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\/agents$/u, {
    pages: [{ pageId: "p-relay", agents: [{ instanceId: "i-codex", name: "codex:1", status: "idle",
      conversationId: E2E_CHANNEL.id, activity: "viewing", blockId: "notes" }, { instanceId: "i-claude", name: "claude:2",
      status: "busy", conversationId: E2E_CHANNEL.id, activity: "editing", blockId: "status" }] }],
  });

  const server = pageDocument(BODY);
  new awarenessProtocol.Awareness(server).setLocalState(null);
  const clientUpdates: number[] = [];
  let connections = 0;
  await servePageSession(browser, server, {
    clientUpdate: () => clientUpdates.push(1),
    connect: (send) => {
      connections++;
      // An Agent starts editing the Status section a moment later.
      setTimeout(() => {
        const agent = encoding.createEncoder();
        encoding.writeVarUint(agent, 1);
        encoding.writeVarUint(agent, 1_234_567);
        encoding.writeVarUint(agent, 1);
        encoding.writeVarString(agent, JSON.stringify({ user: { name: "claude:2", color: "#7c3aed", kind: "agent",
          conversationId: E2E_CHANNEL.id }, activity: "editing", block: "status" }));
        const aware = encoding.createEncoder();
        encoding.writeVarUint(aware, 1);
        encoding.writeVarUint8Array(aware, encoding.toUint8Array(agent));
        send(encoding.toUint8Array(aware));
        // It claims the section, and everyone on the page sees it at once.
        const claims = encoding.createEncoder();
        encoding.writeVarUint(claims, 2);
        encoding.writeVarString(claims, JSON.stringify({ type: "claims", claims: [{ claimId: "c1", pageId: "p-relay",
          blockId: "status", holder: { kind: "agent", id: "claude:2", label: "claude:2" }, ownerUserId: "someone-else",
          conversationId: E2E_CHANNEL.id, pullRequestUrl: null, expiresAt: "2026-09-26T14:00:00.000Z", createdAt: NOW }] }));
        send(encoding.toUint8Array(claims));
        editPageMarkdown(server, (markdown) => markdown.replace("In progress", "Shipped"), "agent");
      }, 500);
    },
  });

  await browser.goto("/app", { waitUntil: "domcontentloaded" });
  await browser.getByRole("button", { name: "Pages", exact: true }).first().click();
  const tree = browser.getByTestId("page-tree");
  await expect(tree).toContainText("Company");
  await expect(tree).toContainText("Relay");
  // The first page opens by default; count the sessions of the page we switch to.
  await expect.poll(() => connections).toBeGreaterThan(0);
  connections = 0;
  await tree.getByRole("button", { name: "Relay" }).click();

  const editor = browser.getByTestId("page-editor");
  await expect(editor).toContainText("Shipped");
  // Who has taken a section and what is said about it are on its heading, not in a list beside it.
  const status = editor.locator("h2", { hasText: "Status" });
  await expect(status.getByTestId("page-claim")).toHaveText("claude:2");
  await expect(status.getByRole("button", { name: "1 conversation about this section" })).toBeVisible();
  await expect(status.getByRole("button", { name: /^Claim/u }), "a claimed section is not offered to claim").toHaveCount(0);
  await expect(editor.locator("h2", { hasText: "Notes" }).getByRole("button", { name: /^Claim/u })).toHaveCount(1);
  await expect(browser.getByTestId("page-outline"), "there is no side panel").toHaveCount(0);

  // Who is on the page, and where, is in its header; a click follows them.
  const now = browser.getByTestId("page-now");
  await expect(now.getByRole("button", { name: `claude:2, editing · Status · in ${E2E_CHANNEL.name}` })).toBeVisible();
  await expect(now.getByRole("button", { name: `codex:1, viewing · Notes · in ${E2E_CHANNEL.name}` })).toBeVisible();
  // The header already says who is where; the headings do not draw them again.
  await expect(editor.locator(".page-section-present [title*='viewing'], .page-section-present [title*='editing']"))
    .toHaveCount(0);
  // As in Google Docs the text carries no change log: who changed the page last is on History's button.
  await expect(editor).not.toContainText("Updated by");
  await expect(browser.getByTestId("pages-view").getByRole("button", { name: /^Version history/u }))
    .toHaveAttribute("title", "Last edit by claude:1 · 2h ago");
  // Work claimed on the Notes ended since, and nobody has written it back: its heading says so.
  const owed = editor.locator("h2", { hasText: "Notes" }).getByTestId("page-owed");
  await expect(owed).toHaveText("Update owed");
  await expect(owed).toHaveAttribute("title", `Update owed · o/r/pull/7 merged 20m ago · open ${E2E_CHANNEL.name}`);

  // The person's own typing reaches the session.
  await editor.getByText("Shipped").click();
  await browser.keyboard.press("End");
  await browser.keyboard.type(" and verified");
  await expect.poll(() => pageMarkdown(server)).toContain("Shipped and verified");
  // Selecting text offers collaboration on the passage. Formatting is typed, or a shortcut.
  await browser.keyboard.press("Shift+Home");
  const selection = browser.getByTestId("page-selection-menu");
  await expect(selection.getByRole("button", { name: "Discuss" })).toBeVisible();
  await expect(browser.getByRole("button", { name: "Bold" })).toHaveCount(0);
  await expect(browser.getByTestId("page-toolbar")).toHaveCount(0);
  await browser.screenshot({ path: test.info().outputPath("pages-selection-menu.png") });
  await browser.keyboard.press("ControlOrMeta+b");
  await expect.poll(() => pageMarkdown(server)).toContain("**Shipped and verified**");
  // Who changed a passage is asked of the passage, as Show editors does in Google Docs.
  await selectLine(browser, "none");
  await selection.getByRole("button", { name: "Show editors" }).click();
  const editors = browser.getByTestId("page-editors");
  await expect(editors).toContainText("claude:1");
  await expect(editors).toContainText("2h ago");
  await expect(editors.getByRole("button", { name: E2E_CHANNEL.name })).toBeVisible();
  await expect(editors.getByRole("button", { name: "See version history" })).toBeVisible();
  await browser.keyboard.press("Escape");
  expect(clientUpdates.length).toBeGreaterThan(0);
  expect(connections, "the page keeps one live session while it is open").toBe(1);
  await browser.screenshot({ path: test.info().outputPath("pages-live.png") });
});

/** `item`'s document as read over HTTP: BODY at `revision`, one edit after the last. */
function editedPageDocument(item: ReturnType<typeof page>, revision: number) {
  return { page: { ...item, body: BODY, revisionInfo: { revision, kind: "edit", authors: [],
    conversationIds: [], basedOnRevision: revision - 1, createdAt: NOW } } };
}

async function openChannelTouchingRelay(browser: import("@playwright/test").Page, summary?: string,
  stubs?: () => Promise<void>) {
  const relay = page("p-relay", null, "Relay", "V");
  await installWorkspaceStubs(browser, { spaces: [E2E_SPACE], channels: [{ ...E2E_CHANNEL, summary }] });
  await fixtureJson(browser, "general-history", "**/api/xmatrix/channels/channel-general/history**",
    { messages: [], hasMore: false });
  await fixtureJson(browser, "conversation-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?conversationId=/u, {
    links: [{ linkId: "l1", conversationId: E2E_CHANNEL.id, pageId: "p-relay", blockId: "status", source: "edit",
      createdAt: NOW, lastSeenAt: NOW }],
  });
  await fixtureJson(browser, "page-relay", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay$/u, editedPageDocument(relay, 3));
  await fixtureJson(browser, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u, { pages: [relay] });
  await fixtureJson(browser, "page-awareness", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/[^/]+\/awareness$/u, {
    pageId: "p-relay", headRevision: 3, blocks: [],
  });
  await stubs?.();
  await browser.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
}

test("a conversation bookmarks the pages it touches, previewing them on hover", async ({ page: browser }) => {
  await openChannelTouchingRelay(browser);
  const cards = browser.getByTestId("conversation-page-cards");
  await expect(cards).toContainText("Relay › Status");
  // Nothing says the section changed, so its small type is what it says now.
  await expect(cards).toContainText("In progress");
  const card = cards.getByRole("button", { name: /Relay › Status/u });
  await card.hover();
  await expect(browser.getByTestId("conversation-page-preview")).toContainText("In progress");
  await card.click();
  await expect(browser.getByTestId("pages-view")).toBeVisible();
  await expect(browser).toHaveURL(/\/pages\?page=p-relay/u);
});

test("a bookmark says in small type what the last change to its section did", async ({ page: browser }) => {
  await openChannelTouchingRelay(browser, undefined, async () => {
    // claude's revision 3 turned the section's "Planned" into "In progress".
    await fixtureJson(browser, "page-awareness", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay\/awareness$/u, {
      pageId: "p-relay", headRevision: 3, blocks: [{ blockId: "status", claims: [], present: [], discussions: [],
        owed: null, updated: { revision: 3, authors: [{ kind: "agent", id: "a1", label: "claude" }],
          conversationIds: [E2E_CHANNEL.id], createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } }],
    });
    await fixtureJson(browser, "page-relay-revision-2", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay\?revision=2$/u,
      { page: { ...page("p-relay", null, "Relay", "V"), body: BODY.replace("In progress", "Planned"),
        revisionInfo: { revision: 2, kind: "edit", authors: [], conversationIds: [], basedOnRevision: 1, createdAt: NOW } } });
  });
  const card = browser.getByTestId("conversation-page-cards").getByRole("button", { name: /Relay › Status/u });
  await expect(card).toContainText("claude 2h ago");
  await expect(card).toContainText("In progress");
  await expect(card).not.toContainText("Planned");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("the pages a conversation touches are chips on its Summary plaque", async ({ page: browser }) => {
    await openChannelTouchingRelay(browser, "Shipping the relay rewrite behind the v2 flag.");
    // One plaque, not a glass card stacked over a wood one.
    await expect(browser.getByTestId("conversation-page-cards")).toBeHidden();
    const plaque = browser.locator(".app-mobile-channel-about");
    await expect(plaque).toHaveCount(1);
    await expect(plaque).toContainText("Shipping the relay rewrite");
    const chip = plaque.getByTestId("mobile-conversation-pages").getByRole("button", { name: "Relay" });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(browser.getByTestId("pages-view")).toBeVisible();
    await expect(browser).toHaveURL(/\/pages\?page=p-relay/u);
  });
});

test("a page: reference in a message is a chip with preview that opens the page", async ({ page: browser }) => {
  const pageId = "0b7c2a1e-4f3d-4c2b-9a8e-1d2c3b4a5f6e";
  const relay = page(pageId, null, "Relay", "V");
  await installWorkspaceStubs(browser, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(browser, "general-history", "**/api/xmatrix/channels/channel-general/history**", {
    messages: [{
      messageId: "m-page-ref", channelId: E2E_CHANNEL.id, sequence: 1,
      body: `Updated \`page:${pageId} (r6)\` per the plan.`,
      from: E2E_USER_SENDER, sentAt: NOW,
    }],
    hasMore: false,
  });
  await fixtureJson(browser, "conversation-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?conversationId=/u, {
    links: [],
  });
  await fixtureJson(browser, "page-doc", new RegExp(`/api/xmatrix/spaces/[^/]+/pages/${pageId}$`, "u"),
    editedPageDocument(relay, 6));
  await fixtureJson(browser, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u, { pages: [relay] });
  await browser.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });

  const chip = browser.getByTestId("page-reference-chip");
  await expect(chip).toContainText("Relay");
  await expect(chip).toContainText("r6");
  await chip.hover();
  const preview = browser.getByTestId("page-reference-preview");
  await expect(preview).toContainText("In progress");
  // It portals into the app root, where the theme lives: a styled panel
  // anchored under the chip, not bare text spread across the page.
  const panel = await preview.evaluate((element) => {
    const style = getComputedStyle(element);
    return { inApp: Boolean(element.closest(".xmatrix-app")), background: style.backgroundColor,
      border: style.borderTopWidth, radius: style.borderTopLeftRadius };
  });
  expect(panel.inApp).toBe(true);
  expect(panel.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(panel.border).toBe("1px");
  expect(panel.radius).toBe("16px");
  const chipBox = (await chip.boundingBox())!;
  const previewBox = (await preview.boundingBox())!;
  expect(previewBox.width).toBeLessThanOrEqual(320);
  expect(previewBox.y).toBeGreaterThanOrEqual(chipBox.y + chipBox.height);
  expect(Math.abs(previewBox.x - chipBox.x)).toBeLessThan(40);
  await chip.click();
  await expect(browser.getByTestId("pages-view")).toBeVisible();
  await expect(browser).toHaveURL(new RegExp(`/pages\\?page=${pageId}`, "u"));
});

test("an owner reviews the drafted pages, adjusts them and applies them", async ({ page: browser }) => {
  await installWorkspaceStubs(browser, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const pageTree = /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u;
  await fixtureJson(browser, "page-tree", pageTree, { pages: [] });
  const draftPage = (key: string, parentKey: string | null, title: string, sources: string[]) => ({
    key, parentKey, title, body: `# ${title}\n\nWhere ${title} stands.\n`, sources });
  const proposed = { spaceId: E2E_SPACE.id, state: "proposed", version: 1, report: null,
    drafter: { kind: "agent", id: "agent-1", label: "claude" },
    draft: { pages: [draftPage("company", null, "Company", ["c-general"]),
      draftPage("relay", "company", "Relay", ["c-relay"]), draftPage("standup", "company", "Standup", ["c-standup"])] },
    sources: [{ conversationId: "c-general", name: "general", closed: false },
      { conversationId: "c-relay", name: "relay", closed: true },
      { conversationId: "c-standup", name: "standup", closed: false }] };
  const report = { pages: 2, links: 2, restrictedPages: 1 };
  const migrationUrl = /\/api\/xmatrix\/spaces\/[^/]+\/page-migration$/u;
  await fixtureJson(browser, "migration-read", migrationUrl, proposed, { method: "GET" });
  await fixtureJson(browser, "migration-revise", /\/page-migration\/draft$/u, { ...proposed, version: 2 },
    { method: "PATCH" });
  await fixtureJson(browser, "migration-apply", /\/page-migration\/apply$/u, { ...proposed, state: "applied", version: 3, report },
    { method: "POST" });

  await browser.goto("/app", { waitUntil: "domcontentloaded" });
  await browser.getByRole("button", { name: "Pages", exact: true }).first().click();
  const review = browser.getByTestId("page-migration-review");
  await expect(review).toContainText("claude drafted these pages");
  await expect(review).toContainText("3 pages");
  await expect(review.getByLabel("restricted")).toHaveCount(1);
  // Dropping a parent shows its children where they will be published: moved up.
  const company = review.getByRole("listitem").filter({ has: browser.getByLabel("Title of Company") });
  const relay = review.getByRole("listitem").filter({ has: browser.getByLabel("Title of Relay") });
  await expect(relay).toHaveCSS("padding-left", "28px");
  await company.getByRole("checkbox").uncheck();
  await expect(relay).toHaveCSS("padding-left", "12px");
  await company.getByRole("checkbox").check();
  await review.getByRole("listitem").filter({ hasText: "standup" }).getByRole("checkbox").uncheck();
  await review.getByLabel("Title of Relay").fill("Relay service");
  await expect(review).toContainText("2 pages");
  await fixtureJson(browser, "page-tree-moved", pageTree, { pages: [page("p-company", null, "Company", "V")] });
  await fixtureJson(browser, "migration-applied", migrationUrl, { ...proposed, state: "applied", version: 3, report },
    { method: "GET" });
  await review.getByRole("button", { name: "Move to pages" }).click();

  const done = browser.getByTestId("page-migration-report");
  await expect(done).toContainText("2 pages · 2 conversation links · 1 restricted page");
  await done.getByRole("button", { name: "Open pages" }).click();
  await expect(browser.getByTestId("page-tree")).toContainText("Company");
  expect(await fixtureRequestBodies(browser, "migration-revise"))
    .toEqual([{ version: 1, drop: ["standup"], titles: { relay: "Relay service" } }]);
  expect(await fixtureRequestBodies(browser, "migration-apply")).toEqual([{ version: 2 }]);
});

test("an owner may start a Space's pages from a repository or a first page, and still review the move", async ({ page: browser }) => {
  await installWorkspaceStubs(browser, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const pageTree = /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u;
  await fixtureJson(browser, "page-tree", pageTree, { pages: [] });
  await fixtureJson(browser, "migration-read", /\/api\/xmatrix\/spaces\/[^/]+\/page-migration$/u,
    { spaceId: E2E_SPACE.id, state: "none", version: 0, drafter: null, draft: { pages: [] }, sources: [], report: null });
  await fixtureJson(browser, "import-repositories", /\/page-migration\/import\/repositories$/u,
    { repos: [{ value: "acme/widgets", private: false }], repoStatus: "authorized" });
  await fixtureJson(browser, "import-start", /\/page-migration\/import$/u, { conversationId: "c-import" },
    { method: "POST" });
  await browser.goto("/app", { waitUntil: "domcontentloaded" });
  await browser.getByRole("button", { name: "Pages", exact: true }).first().click();
  await expect(browser.getByTestId("page-migration-review")).toContainText("Draft this Space's move to pages.");
  // Or it starts from one of the Space's GitHub repositories.
  const importing = browser.getByTestId("page-import");
  await importing.getByLabel("Repository").click();
  await importing.getByRole("option", { name: "acme/widgets" }).click();
  await importing.getByRole("button", { name: "Draft pages" }).click();
  await expect(importing).toContainText("An Agent is drafting pages from acme/widgets");
  await expect.poll(() => fixtureRequestBodies(browser, "import-start")).toEqual([{ repository: "acme/widgets" }]);

  await fixtureJson(browser, "page-tree-first", pageTree, { pages: [page("p-first", null, "First document", "V")] });
  await fixtureJson(browser, "page-create", pageTree, { page: page("p-first", null, "First document", "V") },
    { method: "POST" });
  await browser.getByRole("button", { name: "Create the first page" }).click();
  const creation = browser.getByRole("dialog", { name: "New page", exact: true });
  await creation.getByLabel("Title", { exact: true }).fill("First document");
  await creation.getByRole("button", { name: "Create", exact: true }).click();
  await expect(creation).toBeHidden();
  await expect(browser.getByTestId("page-migration-review")).toBeHidden();
  await expect(browser.getByTestId("pages-view")).toContainText("First document");
  // An owner publishes the page for anyone with the link.
  await fixtureJson(browser, "page-publish", /\/pages\/p-first\/publication$/u,
    { page: { ...page("p-first", null, "First document", "V"), publishedAt: NOW } }, { method: "PUT" });
  await browser.getByTestId("pages-view").getByRole("button", { name: "Share" }).click();
  await browser.getByLabel("Anyone with the link can read this page").click();
  await expect.poll(async () => fixtureRequestBodies(browser, "page-publish")).toEqual([{ published: true }]);
  // Once an Agent drafts the move, the page says so until it is applied, however many pages exist.
  await fixtureJson(browser, "migration-proposed", /\/api\/xmatrix\/spaces\/[^/]+\/page-migration$/u,
    { spaceId: E2E_SPACE.id, state: "proposed", version: 1, drafter: null, draft: { pages: [] }, sources: [], report: null },
    { method: "GET" });
  await browser.reload({ waitUntil: "domcontentloaded" });
  await browser.getByRole("button", { name: "Pages", exact: true }).first().click();
  await browser.getByTestId("page-migration-notice").getByRole("button", { name: "Review" }).click();
  await expect(browser.getByTestId("page-migration-review")).toBeVisible();
});

const LAMBDA = "# Lambda Labs\n\n公司当前有三条业务线，每条都按“能独立经营”来设计。完整梳理见仓库 `docs/ARCHITECTURE.md`。\n\n| 业务线 | 是什么 |\n|---|---|\n| xMatrix | 人和 Agent 一起工作的协作系统：对话、Pages |\n| xaccelerator.io | AI 原生 3D 游戏世界引擎 |\n\n各业务线的子页面在本页下面，见 [路线图](https://xmatrix.sh/p/a/b)。\n\n## 怎么工作\n- 人只管说话；**Agent 执行**，并把现状写回页面。\n- 所有时间写 UTC 或带时区。\n\n> 引用一段\n\n---\n\n## 待决定\n- 见各业务线页面的“待决定”一节。\n";

test("a page is typed like Typora: the caret's line shows its markers", async ({ page: browser }) => {
  await stubPages(browser, [page("p-relay", null, "Lambda Labs", "V")]);
  await fixtureJson(browser, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, { links: [] });
  const server = pageDocument(LAMBDA);
  await servePageSession(browser, server);
  await browser.goto("/app", { waitUntil: "domcontentloaded" });
  await browser.getByRole("button", { name: "Pages", exact: true }).first().click();
  const editor = browser.getByTestId("page-editor");
  await expect(editor).toContainText("怎么工作");
  const table = editor.locator("table");
  await expect(table).toBeVisible();
  await expect(table.locator("th")).toHaveText(["业务线", "是什么"]);
  await expect(editor).not.toContainText("|---|");
  await expect(editor.locator("ul > li")).toHaveCount(3);
  await expect(editor.getByText("路线图")).toBeVisible();
  await browser.screenshot({ path: test.info().outputPath("pages-preview.png") });

  // The caret's heading shows its marker. A table, a code span and a link elsewhere stay rendered.
  const title = editor.locator("h1", { hasText: "Lambda Labs" });
  await title.click();
  await expect(title.locator(".page-md-syntax")).toHaveText("# ");
  for (const width of [393, 1280]) {
    await browser.setViewportSize({ width, height: 852 });
    const markerFit = await title.evaluate((heading) => {
      const marker = heading.querySelector(".page-md-syntax");
      if (!marker) return null;
      const headingStyle = getComputedStyle(heading);
      const markerStyle = getComputedStyle(marker);
      const text = Array.from(heading.childNodes).find((node) =>
        node.nodeType === Node.TEXT_NODE && node.textContent?.includes("Lambda"));
      const range = document.createRange();
      if (text) range.selectNodeContents(text);
      const textBox = text ? range.getBoundingClientRect() : null;
      const tools = heading.querySelector(".page-heading-tools")?.getBoundingClientRect() ?? null;
      const box = heading.getBoundingClientRect();
      return {
        sameSize: markerStyle.fontSize === headingStyle.fontSize,
        sameFamily: markerStyle.fontFamily === headingStyle.fontFamily,
        toolsClearOfTitle: tools && textBox ? tools.left - textBox.right : null,
        toolsAtEnd: tools ? box.right - tools.right : null,
        sameLine: tools && textBox ? Math.abs(tools.top - textBox.top) < 24 : false,
      };
    });
    expect(markerFit?.sameSize, `the # uses the heading's size at ${width}`).toBe(true);
    expect(markerFit?.sameFamily, `the # uses the heading's font at ${width}`).toBe(true);
    expect(markerFit?.sameLine, `section actions stay on the title's row at ${width}`).toBe(true);
    expect(markerFit?.toolsClearOfTitle ?? 0, `section actions sit clear of the title at ${width}`).toBeGreaterThan(16);
    expect(markerFit?.toolsAtEnd ?? 99, `section actions sit at the row's right edge at ${width}`).toBeLessThan(8);
    if (width === 1280) await expect(browser.getByTestId("page-title"), "the heading already is the title").toHaveCount(0);
  }
  await expect(editor).not.toContainText("|---|");
  await expect(editor).not.toContainText("`docs/");
  await expect(editor).not.toContainText("](https://");

  // In a table, that marker is gone and the table stays a table.
  await table.getByText("AI 原生 3D 游戏世界引擎").click();
  await expect(title.locator(".page-md-syntax")).toHaveCount(0);
  await expect(table).toBeVisible();
  await expect(editor).not.toContainText("|---|");

  const emphasis = editor.locator("li", { hasText: "Agent 执行" });
  await emphasis.locator("strong").click();
  await expect(emphasis.locator(".page-md-syntax").first()).toHaveText("**");
  await editor.getByText("路线图", { exact: true }).click();
  await expect(editor.locator(".page-md-syntax", { hasText: "](https://xmatrix.sh/p/a/b)" })).toBeVisible();
  await expect(emphasis.locator(".page-md-syntax")).toHaveCount(0);

  // Markdown typing and the insert menu make structure, and the session gets markdown.
  await editor.getByText("所有时间写").click({ clickCount: 3 });
  await expect(editor.locator(".page-document")).toBeFocused();
  await browser.keyboard.press("ArrowRight");
  const items = editor.locator("ul").first().locator("li");
  await browser.keyboard.press("Enter");
  await expect(items, "Enter starts a new item").toHaveCount(3);
  await browser.keyboard.press("Enter");
  await expect(items, "Enter on an empty item leaves the list").toHaveCount(2);
  await browser.keyboard.type("## Owners");
  await browser.keyboard.press("Enter");
  await browser.keyboard.type("/check");
  await expect(browser.getByTestId("page-insert-menu")).toContainText("Checklist");
  await browser.screenshot({ path: test.info().outputPath("pages-insert-menu.png") });
  await browser.keyboard.press("Enter");
  await browser.keyboard.type("Pick an owner for each line");
  await expect(editor.locator("h2", { hasText: "Owners" })).toBeVisible();
  await expect(editor.locator("li.page-task")).toHaveCount(1);
  await expect.poll(() => pageMarkdown(server)).toContain("## Owners\n\n- [ ] Pick an owner for each line");
  await browser.screenshot({ path: test.info().outputPath("pages-editing.png") });
});

test("a page shows its document at once, and the live editor takes over when its session syncs", async ({ page: browser }) => {
  await stubPages(browser, [page("p-relay", null, "Relay", "V")]);
  await fixtureJson(browser, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, { links: [] });
  await fixtureJson(browser, "page-document", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay$/u, { page: {
    ...page("p-relay", null, "Relay", "V"), body: "# Relay\n\n| Area | State |\n|---|---|\n| Search | Next |\n",
    revisionInfo: { revision: 3, kind: "edit", authors: [], conversationIds: [], createdAt: NOW } } });
  const server = pageDocument("# Relay\n\n| Area | State |\n|---|---|\n| Search | Shipped |\n");
  await servePageSession(browser, server, { syncAfterMs: 3_000 });

  await browser.goto("/app", { waitUntil: "domcontentloaded" });
  await browser.getByRole("button", { name: "Pages", exact: true }).first().click();
  const preview = browser.getByTestId("page-preview");
  await expect(preview.locator("table")).toContainText("Next");
  await expect(browser.getByTestId("page-editor")).toBeHidden();
  // The preview is drawn as the editor draws the page, so nothing moves when the editor takes its place.
  const boxes = (root: ReturnType<typeof browser.getByTestId>) => Promise.all(["h1", "table"].map((selector) =>
    root.locator(selector).first().boundingBox()));
  const before = await boxes(preview);

  await expect(preview).toBeHidden({ timeout: 10_000 });
  const editor = browser.getByTestId("page-editor");
  await expect(editor.locator("table")).toContainText("Shipped");
  const after = await boxes(editor);
  for (const [index, box] of before.entries()) {
    expect(Math.abs((after[index]?.y ?? 0) - (box?.y ?? -100)), "the page does not move").toBeLessThanOrEqual(1);
    expect(Math.abs((after[index]?.height ?? 0) - (box?.height ?? -100))).toBeLessThanOrEqual(1);
  }
});

test("what changed since the reader last read the page plays as it comes into view, and the page is then read", async ({ page: browser }) => {
  await stubPages(browser, [page("p-relay", null, "Relay", "V")]);
  await fixtureJson(browser, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, { links: [] });
  await fixtureJson(browser, "page-read", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay\/read$/u, { revision: 2 },
    { method: "GET" });
  await fixtureJson(browser, "page-mark-read", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay\/read$/u, { revision: 3 },
    { method: "PUT" });
  await fixtureJson(browser, "page-revision-2", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay\?revision=2$/u, { page: {
    ...page("p-relay", null, "Relay", "V"), body: "# Relay\n\n## Status\n\nPlanned for next week\n\n## Notes\n\nnone\n",
    revisionInfo: { revision: 2, kind: "edit", authors: [], conversationIds: [], createdAt: NOW } } });
  const editor = await openLivePage(browser,
    "# Relay\n\n## Status\n\nShipped this week\n\n## Notes\n\nnone\n\n## Risks\n\nLate reviews\n");

  const added = editor.locator(".page-reader-change");
  await expect(added.filter({ hasText: "Shipped" })).toBeVisible();
  await expect(added.filter({ hasText: "Late reviews" })).toHaveCount(1);
  await expect(editor.locator(".page-reader-removed")).toContainText("Planned for next");
  await browser.screenshot({ path: test.info().outputPath("pages-reader-changes.png") });
  // Once played, the page is as it is.
  await expect(added).toHaveCount(0, { timeout: 10_000 });
  await expect(editor.locator(".page-reader-removed")).toHaveCount(0);
  await expect(editor).toContainText("Shipped this week");
  await expect.poll(async () => (await fixtureRequestBodies(browser, "page-mark-read")).map((body) => body.revision))
    .toContain(3);
});

test("an editor that meets a Hub still keeping pages as text waits instead of showing an empty page", async ({ page: browser }) => {
  await stubPages(browser, [page("p-relay", null, "Relay", "V")]);
  await fixtureJson(browser, "page-live", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/[^/]+\/live$/u, {
    protocol: "xmatrix-page-v1.ticket", socketPath: "/ws/pages/space-personal/p-relay", canEdit: true, headRevision: 3,
  });
  await fixtureJson(browser, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, { links: [] });
  await fixtureJson(browser, "page-document", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay$/u, { page: {
    ...page("p-relay", null, "Relay", "V"), body: BODY,
    revisionInfo: { revision: 3, kind: "edit", authors: [], conversationIds: [], createdAt: NOW } } });
  let sockets = 0;
  await browser.routeWebSocket(/\/ws\/pages\//u, () => { sockets++; });

  await browser.goto("/app", { waitUntil: "domcontentloaded" });
  await browser.getByRole("button", { name: "Pages", exact: true }).first().click();
  await expect(browser.getByTestId("page-preview")).toContainText("In progress");
  await expect(browser.getByTestId("pages-view")).toContainText("Live editing is being updated");
  expect(sockets, "it never joins the old session").toBe(0);
});

test("selecting a passage starts a discussion anchored to it, drawn beside the text until it is resolved", async ({ page: browser }) => {
  await stubPages(browser, [page("p-relay", null, "Relay", "V")]);
  const pageLinks = /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u;
  await fixtureJson(browser, "page-links", pageLinks, { links: [] });
  const discussion = { ...E2E_CHANNEL, id: "channel-discussion", name: "“In progress”" };
  await stubPageConversation(browser, discussion, { linkId: "l-discuss", blockId: "status" });
  const editor = await openLivePage(browser);
  await selectLine(browser, "In progress");
  await browser.getByTestId("page-selection-menu").getByRole("button", { name: "Discuss" }).click();
  await expect.poll(async () => (await fixtureRequestBodies(browser, "link-create"))[0]).toMatchObject({
    conversationId: discussion.id, pageId: "p-relay", blockId: "status", anchor: { quote: "In progress" } });
  const created = (await fixtureRequestBodies(browser, "channel-create"))[0];
  expect(created.name, "a discussion is named by its passage").toBe("“In progress”");
  // It opens beside the page, ready to write in; the page stays where it was.
  await expect(browser).toHaveURL(/page=p-relay&conversation=channel-discussion/u);
  await expect(browser.getByTestId("page-conversation")).toBeVisible();
  await expect(editor).toContainText("In progress");
  // Its composer holds the passage and where it came from, the context its first message carries.
  await expect(browser.locator("textarea.composer-textarea").first())
    .toHaveValue(/^> In progress\n\n— \[Relay › Status\]\([^)]*#status\)\n\n$/u);

  // Closed again, the passage is marked and its bubble opens the discussion.
  const anchor = (await fixtureRequestBodies(browser, "link-create"))[0]!.anchor;
  await fixtureJson(browser, "page-links", pageLinks, { links: [{ linkId: "l-discuss", conversationId: E2E_CHANNEL.id,
    pageId: "p-relay", blockId: "status", source: "manual", createdAt: NOW, lastSeenAt: NOW, anchor, resolvedAt: null }] });
  await fixtureJson(browser, "link-resolve", /\/page-links\/l-discuss\/resolution$/u, { link: {} }, { method: "PUT" });
  await browser.getByRole("button", { name: "Close the conversation" }).click();
  await expect(browser.getByTestId("page-conversation")).toBeHidden();
  await expect(browser).not.toHaveURL(/conversation=/u);
  await expect(editor.locator(".page-discussion")).toHaveText("In progress");
  await expect(editor.getByRole("button", { name: `Open the discussion ${E2E_CHANNEL.name}` })).toBeVisible();
  await browser.screenshot({ path: test.info().outputPath("pages-discussion.png") });
  // The section's conversations list it, and resolve it once its outcome is in the page.
  await editor.locator("h2", { hasText: "Status" }).getByRole("button", { name: "1 conversation about this section" }).click();
  const list = browser.getByTestId("page-conversations");
  await expect(list).toContainText("In progress");
  await list.getByRole("button", { name: "Resolve" }).click();
  await expect.poll(async () => fixtureRequestBodies(browser, "link-resolve")).toEqual([{ resolved: true }]);
});

test("a page's Automations are chips in their sections, listed from its menu and attached from a heading", async ({ page: browser }) => {
  const nextRunAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const release = { id: "auto-release", version: 1, ownerUserId: "e2e-user", authorityRootUserId: "e2e-user",
    name: "Release check", channelId: E2E_CHANNEL.id, pageId: "p-relay", spaceId: E2E_SPACE.id, blockId: "status",
    canManage: true, capabilities: { update: true, pause: true, requestPause: false, resume: false, delete: true,
      reasonRequired: false },
    expression: { kind: "text", language: "natural-language", text: "check the release" },
    message: { body: "check the release" }, intervalMinutes: 1440, enabled: true,
    triggers: [{ kind: "merged", repository: "acme/widgets", installationId: "1" }],
    createdAt: NOW, updatedAt: NOW, nextRunAt, runCount: 0, deliveryCount: 0 };
  const detached = { ...release, id: "auto-sweep", name: "Old sweep", blockId: undefined, enabled: false,
    detachedAt: NOW, capabilities: { ...release.capabilities, pause: false } };
  await stubPages(browser, [page("p-relay", null, "Relay", "V")]);
  await fixtureJson(browser, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, { links: [] });
  const automations = /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay\/automations$/u;
  await fixtureJson(browser, "page-automations", automations, { automations: [release, detached] }, { method: "GET" });
  await fixtureJson(browser, "automation-create", automations, { automation: { ...release, id: "auto-weekly" } },
    { method: "POST" });
  await fixtureJson(browser, "automation-reference", /\/automations\/auto-sweep\/reference$/u,
    { automation: { ...detached, detachedAt: undefined, enabled: true, blockId: "notes" } }, { method: "POST" });
  const editor = await openLivePage(browser,
    "# Relay\n\n## Status\n\nIn progress\n\n[Release check](xmatrix:automation/auto-release)\n\n## Notes\n\nnone\n");
  // The reference reads as a chip whose state comes from the Automation, not from the page's text.
  await expect(editor.locator(".page-automation-chip")).toHaveText("Release check");
  await expect(editor.locator(".page-automation-status")).toHaveText("daily · next in 3 h");
  await browser.screenshot({ path: test.info().outputPath("pages-automation-chip.png") });

  // There is no page-wide list: a running one is its chip, and a detached one is put back from a heading.
  await expect(browser.getByTestId("pages-view").getByRole("button", { name: "Page menu" })).toHaveCount(0);
  const notes = editor.locator("h2", { hasText: "Notes" });
  await notes.hover();
  await notes.getByRole("button", { name: "Attach a schedule or a repository to this section" }).click();
  const putBack = browser.getByRole("dialog", { name: "Attach to Notes" }).getByTestId("page-attached");
  await expect(putBack.getByTestId("page-automation")).toHaveCount(1);
  await expect(putBack).toContainText("Old sweep");
  await expect(putBack).toContainText("paused, its reference left the page");
  await putBack.getByRole("button", { name: "Put back here" }).click();
  await expect.poll(async () => fixtureRequestBodies(browser, "automation-reference")).toEqual([{ blockId: "notes" }]);
  await expect(browser.getByRole("dialog", { name: "Attach to Notes" })).toBeHidden();

  // Attaching starts from the section it is for.
  await notes.hover();
  await notes.getByRole("button", { name: "Attach a schedule or a repository to this section" }).click();
  const attach = browser.getByRole("dialog", { name: "Attach to Notes" });
  const attached = attach.getByTestId("page-attached");
  await attached.getByRole("button", { name: "Schedule" }).click();
  await expect(attached.getByRole("combobox", { name: "Section" }), "the heading already said where").toHaveCount(0);
  await attached.getByLabel("Name").fill("Weekly review");
  await attached.getByLabel("What to do each time").fill("@auto review the notes and update them");
  await attached.getByRole("combobox", { name: "How often" }).click();
  await browser.getByRole("option", { name: "Weekly" }).click();
  await attached.getByRole("combobox", { name: "Also run" }).click();
  await browser.getByRole("option", { name: "Also when a pull request merges" }).click();
  await attached.getByLabel("Repository to watch").fill("acme/widgets");
  await attached.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect.poll(async () => (await fixtureRequestBodies(browser, "automation-create"))[0]).toEqual({
    name: "Weekly review", instruction: "@auto review the notes and update them", intervalMinutes: 10080,
    blockId: "notes", triggers: [{ kind: "merged", repository: "acme/widgets" }] });
  // The page stays open: what was scheduled works in its own conversation.
  await expect(attach).toBeHidden();
  await expect(browser.getByTestId("pages-view")).toBeVisible();
});

test("a page's conversations sit beside what they are about, and one opens there among the others", async ({ page: browser }) => {
  await browser.setViewportSize({ width: 1600, height: 900 });
  const release = { ...E2E_CHANNEL, id: "channel-release", name: "Release notes" };
  const quiet = { ...E2E_CHANNEL, id: "channel-quiet", name: "Last month's notes" };
  const plan = { ...E2E_CHANNEL, id: "channel-plan", name: "Changelog wording" };
  await stubPages(browser, [page("p-relay", null, "Relay", "V")], [E2E_CHANNEL, release, quiet, plan]);
  const recent = new Date(Date.now() - 5 * 60_000).toISOString();
  await fixtureJson(browser, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, {
    links: [
      { linkId: "l-release", conversationId: release.id, pageId: "p-relay", blockId: "status", source: "edit",
        createdAt: NOW, lastSeenAt: recent },
      { linkId: "l-quiet", conversationId: quiet.id, pageId: "p-relay", blockId: "notes", source: "read",
        createdAt: NOW, lastSeenAt: NOW },
      { linkId: "l-plan", conversationId: plan.id, pageId: "p-relay", blockId: "notes", source: "manual",
        createdAt: NOW, lastSeenAt: recent },
    ],
    conversations: [
      { conversationId: release.id, name: release.name, activityAt: recent, headSequence: 4, readSequence: 4,
        lastMessage: { from: { kind: "agent", label: "claude:1" }, bodyPreview: "Drafted the notes; checking the changelog.",
          sentAt: recent },
        agents: [{ instanceId: "i-1", name: "claude:1", status: "busy" }] },
      { conversationId: quiet.id, name: quiet.name, activityAt: NOW, headSequence: 9, readSequence: 9,
        lastMessage: null, agents: [] },
      { conversationId: plan.id, name: plan.name, activityAt: recent, headSequence: 2, readSequence: 2,
        lastMessage: { from: { kind: "user", label: "Yiming Hu" }, bodyPreview: "Say what changed for users, not which files moved.",
          sentAt: recent }, agents: [] },
    ],
  });
  const said = (sequence: number, from: Record<string, unknown>, body: string) => ({ messageId: `release-${sequence}`,
    channelId: release.id, sequence, body, sentAt: recent, reactions: [], annotations: [], attachments: [], from });
  await fixtureJson(browser, "release-history", "**/api/xmatrix/channels/channel-release/history**", {
    messages: [
      said(1, E2E_USER_SENDER, "Draft the release notes for Status."),
      said(2, { kind: "agent", identityId: "agent:channel-release:1", agentId: "channel-release:1", userId: "owner-0",
        email: "", label: "claude:1", agentName: "claude", instanceId: "channel-release:1", channelInstanceId: "1",
        instanceLabel: "claude" }, "Drafted the notes; checking the changelog."),
    ],
    hasMore: false, historyHeadSequence: 2 });
  const editor = await openLivePage(browser);
  await expect(editor).toContainText("In progress");

  // A live conversation sits beside the section it is about, as a comment does in Google Docs.
  const cards = browser.getByTestId("page-margin").getByTestId("page-margin-card");
  await expect(cards).toHaveCount(2);
  const card = cards.filter({ hasText: "Release notes" });
  await expect(card).toContainText("claude:1");
  await expect(card).toContainText("Drafted the notes; checking the changelog.");
  await expect(card).toContainText("claude:1 · Working");
  const status = editor.locator("h2", { hasText: "Status" });
  await expect.poll(async () => Math.abs((await card.boundingBox())!.y - (await status.boundingBox())!.y),
    { message: "the card is level with its section's heading" }).toBeLessThan(4);
  // The Agent works in that conversation, not on the page, and the section says so.
  await expect(status.locator(".page-section-working")).toHaveAttribute("title", "claude:1 · Working · in Release notes");
  // A conversation gone quiet leaves the margin and the text; the header's count still lists it,
  // as Google Docs keeps older comments behind its comment history.
  await expect(browser.getByTestId("pages-view").getByRole("button", { name: "3 conversations about this page" }))
    .toBeVisible();
  await expect(editor).not.toContainText("quiet conversation");
  await browser.screenshot({ path: test.info().outputPath("pages-margin.png") });

  // Opening it keeps the page: the conversation expands in its card's place, as a comment does in
  // Google Docs, level with its section, and the page's other conversations stay beside the page.
  await card.click();
  await expect(browser).toHaveURL(/page=p-relay&conversation=channel-release/u);
  const open = browser.getByTestId("page-margin").getByTestId("page-margin-open");
  await expect(open).toContainText("Release notes");
  await expect(open.getByTestId("page-conversation")).toContainText("Drafted the notes; checking the changelog.");
  await expect(editor).toContainText("In progress");
  await expect.poll(async () => Math.abs((await open.boundingBox())!.y - (await status.boundingBox())!.y),
    { message: "the open conversation is level with its section's heading" }).toBeLessThan(4);
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("Changelog wording");
  // A thread is as tall as what it says, not a column: two messages make a short card.
  await expect.poll(async () => (await open.boundingBox())!.height,
    { message: "the open thread is sized to its messages" }).toBeLessThan(320);
  await expect(open.getByText("Draft the release notes for Status.")).toBeVisible();
  await expect(open.getByText("Drafted the notes; checking the changelog.")).toBeVisible();
  // It lines up with the cards around it, and its text starts where theirs does.
  const [openBox, restBox] = [(await open.boundingBox())!, (await cards.boundingBox())!];
  expect(Math.abs(openBox.x - restBox.x)).toBeLessThan(1);
  expect(Math.abs(openBox.width - restBox.width)).toBeLessThan(1);
  const textX = async (text: import("@playwright/test").Locator) => (await text.boundingBox())!.x;
  expect(Math.abs(await textX(open.getByText("Draft the release notes for Status."))
    - await textX(cards.getByText("Say what changed for users, not which files moved.")))).toBeLessThan(1);
  // What an Agent is doing is on its card; the heading does not repeat it as an unlabeled mark.
  await expect(status.locator(".page-section-working")).toBeHidden();
  await browser.screenshot({ path: test.info().outputPath("pages-conversation-beside.png") });
  // Back closes it, and its card returns.
  await browser.goBack();
  await expect(open).toBeHidden();
  await expect(cards).toHaveCount(2);
  await expect(browser).toHaveURL(/page=p-relay$/u);
});

test("selecting a passage asks AI about it without leaving the page", async ({ page: browser }) => {
  await stubPages(browser, [page("p-relay", null, "Relay", "V")]);
  await fixtureJson(browser, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, { links: [] });
  const asked = { ...E2E_CHANNEL, id: "channel-ask", name: "Ask: what is left" };
  await stubPageConversation(browser, asked, { linkId: "l-ask", blockId: "status" });
  await fixtureJson(browser, "ask-message", /\/api\/xmatrix\/channels\/channel-ask\/messages$/u, { message: {} },
    { method: "POST" });
  await openLivePage(browser);
  await selectLine(browser, "In progress");
  await browser.getByTestId("page-selection-menu").getByRole("button", { name: "Ask AI" }).click();
  const ask = browser.getByTestId("page-ask");
  await expect(ask).toContainText("In progress");
  await ask.getByLabel("Your question").fill("what is left");
  await browser.screenshot({ path: test.info().outputPath("pages-ask.png") });
  await browser.keyboard.press("Enter");
  await expect.poll(async () => (await fixtureRequestBodies(browser, "link-create"))[0]).toMatchObject({
    conversationId: asked.id, blockId: "status", anchor: { quote: "In progress" } });
  const [message] = await fixtureRequestBodies(browser, "ask-message");
  expect(String(message!.body)).toBe("@xMatrix what is left\n\nAbout this passage of page:p-relay (section #status):\n> In progress");
  // The discussion opens beside the page, where the answer arrives.
  await expect(browser).toHaveURL(/conversation=channel-ask/u);
  await expect(browser.getByTestId("page-conversation")).toBeVisible();
  await expect(ask).toBeHidden();
});

test("a page's history shows what each revision changed, colored, and the conversation it came from", async ({ page: browser }) => {
  await stubPages(browser, [page("p-relay", null, "Relay", "V")]);
  await fixtureJson(browser, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, { links: [] });
  const revision = (n: number) => ({ revision: n, kind: "edit", authors: [{ kind: "agent", id: "a", label: "claude:1" }],
    conversationIds: [E2E_CHANNEL.id], basedOnRevision: n - 1, createdAt: new Date().toISOString() });
  await fixtureJson(browser, "page-history", /\/pages\/p-relay\/history$/u, { revisions: [revision(3), revision(2)] });
  const body = (text: string) => ({ page: { ...page("p-relay", null, "Relay", "V"), body: text,
    revisionInfo: revision(3) } });
  await fixtureJson(browser, "revision-3", /\/pages\/p-relay\?revision=3$/u, body(BODY.replace("In progress", "Shipped")));
  await fixtureJson(browser, "revision-2", /\/pages\/p-relay\?revision=2$/u, body(BODY));
  await openLivePage(browser);
  await browser.getByTestId("pages-view").getByRole("button", { name: /^Version history/u }).click();
  // As in Google Docs: versions grouped by day, each with its time and its editors in their colours,
  // and the newest open, its additions highlighted in its author's colour.
  const versions = browser.getByTestId("page-versions");
  await expect(versions.locator("h3")).toHaveText(["Today"]);
  await expect(versions.getByRole("button", { name: /by claude:1$/u })).toHaveCount(2);
  const diff = browser.getByTestId("page-revision-diff");
  await expect(diff.locator('[data-change="removed"]')).toHaveText("In progress");
  await expect(diff.locator('[data-change="added"]')).toHaveText("Shipped");
  await expect(browser.getByTestId("page-history")).toContainText(`in ${E2E_CHANNEL.name}`);
  await browser.screenshot({ path: test.info().outputPath("pages-version-history.png") });
});

test("two people co-edit a page live: each sees the other's typing and cursor, and the session gets both", async ({ page: first, browser }) => {
  const server = pageDocument(BODY);
  const second = await browser.newContext({ ...E2E_DESKTOP_CONTEXT, baseURL: test.info().project.use.baseURL });
  const other = await second.newPage();
  try {
    for (const person of [first, other]) {
      await stubPages(person, [page("p-relay", null, "Relay", "V")]);
      await fixtureJson(person, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, { links: [] });
      await servePageSession(person, server);
      await person.goto("/app", { waitUntil: "domcontentloaded" });
      await person.getByRole("button", { name: "Pages", exact: true }).first().click();
      await expect(person.getByTestId("page-editor")).toContainText("In progress");
    }

    // Each types in a different section at the same time.
    await first.getByTestId("page-editor").getByText("In progress").click();
    await first.keyboard.press("End");
    await other.getByTestId("page-editor").getByText("none").click();
    await other.keyboard.press("End");
    await Promise.all([first.keyboard.type(" and on track"), other.keyboard.type(" so far")]);

    for (const person of [first, other]) {
      await expect(person.getByTestId("page-editor")).toContainText("In progress and on track");
      await expect(person.getByTestId("page-editor")).toContainText("none so far");
    }
    await expect.poll(() => pageMarkdown(server)).toContain("In progress and on track");
    await expect.poll(() => pageMarkdown(server)).toContain("none so far");
    // Each sees where the other is, with a name on the cursor.
    await expect(first.locator(".ProseMirror-yjs-cursor")).toHaveCount(1);
    await expect(other.locator(".ProseMirror-yjs-cursor")).toHaveCount(1);
    await expect(first.locator(".ProseMirror-yjs-cursor")).toContainText("E2E Tester");
    await expect(first.getByTestId("page-save-state")).toHaveText("All changes saved");
    await first.screenshot({ path: test.info().outputPath("pages-coediting.png") });
  } finally {
    await second.close();
  }
});

/** Someone's presence on the page, as the session relays it; `caret` is the text their caret follows. */
function awarenessFrom(server: Y.Doc, clientId: number, clock: number, state: Record<string, unknown>,
  caret?: string): Uint8Array {
  let cursor: unknown = null;
  if (caret) {
    const walk = (type: Y.XmlFragment | Y.XmlElement): Y.XmlText | null => {
      for (const child of type.toArray()) {
        if (child instanceof Y.XmlText && child.toString().includes(caret)) return child;
        if (child instanceof Y.XmlElement) { const found = walk(child); if (found) return found; }
      }
      return null;
    };
    const text = walk(server.getXmlFragment("prosemirror"))!;
    const at = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, text.toString().indexOf(caret)
      + caret.length));
    cursor = { anchor: at, head: at };
  }
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, 1);
  encoding.writeVarUint(update, clientId);
  encoding.writeVarUint(update, clock);
  encoding.writeVarString(update, JSON.stringify({ ...state, ...(cursor ? { cursor } : {}) }));
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, 1);
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
  return encoding.toUint8Array(message);
}

test("on a long page, who works out of view shows at its edges, and what an Agent writes is tinted as its own", async ({ page: browser }) => {
  const filler = Array.from({ length: 60 }, (_, index) => `Background paragraph ${index + 1}.`).join("\n\n");
  const server = pageDocument(`# Relay\n\n## Status\n\nIn progress\n\n${filler}\n\n## Notes\n\nnone\n`);
  const AGENT = 1_234_567;
  let push: (data: Uint8Array) => void = () => {};
  await stubPages(browser, [page("p-relay", null, "Relay", "V")]);
  await fixtureJson(browser, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, { links: [] });
  await fixtureJson(browser, "page-agents", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\/agents$/u, {
    pages: [{ pageId: "p-relay", agents: [{ instanceId: "i-claude", name: "claude:2", status: "busy",
      conversationId: E2E_CHANNEL.id, activity: "editing", blockId: "notes" }] }],
  });
  await servePageSession(browser, server, { connect: (send) => { push = send; } });
  await browser.goto("/app", { waitUntil: "domcontentloaded" });
  await browser.getByRole("button", { name: "Pages", exact: true }).first().click();
  const editor = browser.getByTestId("page-editor");
  await expect(editor).toContainText("In progress");

  // Someone reads the Status at the top; an Agent edits the Notes far below, writing as its own client.
  push(awarenessFrom(server, 7_654_321, 1, { user: { name: "Ada", color: "#0891b2", kind: "user" },
    activity: "viewing", block: "status" }, "In progress"));
  const own = server.clientID;
  server.clientID = AGENT;
  editPageMarkdown(server, (markdown) => markdown.replace("none", "none yet, shipping Friday"), "agent");
  server.clientID = own;
  push(awarenessFrom(server, AGENT, 1, { user: { name: "claude:2", color: "#7c3aed", kind: "agent",
    conversationId: E2E_CHANNEL.id }, activity: "editing", block: "notes" }, "shipping Friday"));

  const below = browser.getByTestId("page-people-below");
  await expect(below).toHaveText(/claude:2 is editing below/u);
  await expect(browser.getByTestId("page-people-above"), "Ada is in view").toHaveCount(0);
  // The Agent's words are marked in its colour where they landed.
  const tinted = editor.locator(`.page-remote-change[data-client="${AGENT}"]`);
  await expect(tinted.first()).toBeAttached();
  await expect(tinted).toContainText(["shipping Friday"]);
  await browser.screenshot({ path: test.info().outputPath("pages-people-below.png") });

  // The hint takes the reader to the Agent's line; the one now above is named at the top edge.
  await below.click();
  await expect(editor.getByText("none yet, shipping Friday")).toBeInViewport();
  await expect(below).toHaveCount(0);
  await expect(browser.getByTestId("page-people-above")).toHaveText(/Ada is reading above/u);
  await browser.screenshot({ path: test.info().outputPath("pages-people-above.png") });
  await browser.getByTestId("page-people-above").click();
  await expect(editor.getByText("In progress")).toBeInViewport();

  // The tint fades away once the change is a few seconds old.
  await expect(tinted).toHaveCount(0, { timeout: 10_000 });

  // Its caret rests where its edit ended while its Run lives, its name tucked away, as Google Docs leaves one.
  const caret = editor.locator(`.ProseMirror-yjs-cursor[data-client="${AGENT}"]`);
  await expect(caret).toHaveCount(1);
  await expect(caret.locator("div")).toHaveCSS("opacity", "0", { timeout: 8_000 });
  const committed = (headRevision: number) => {
    const notice = encoding.createEncoder();
    encoding.writeVarUint(notice, 2);
    encoding.writeVarString(notice, JSON.stringify({ type: "committed", revision: headRevision, headRevision }));
    return encoding.toUint8Array(notice);
  };
  // Its Run finishes the turn: the caret stays, dimmed.
  await fixtureJson(browser, "page-agents", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\/agents$/u, {
    pages: [{ pageId: "p-relay", agents: [{ instanceId: "i-claude", name: "claude:2", status: "idle",
      conversationId: E2E_CHANNEL.id, activity: "editing", blockId: "notes" }] }],
  });
  push(committed(5));
  await expect(caret).toHaveClass(/is-idle/u);
  await browser.screenshot({ path: test.info().outputPath("pages-agent-caret-idle.png") });
  // The Run goes to sleep: its caret goes with it.
  await fixtureJson(browser, "page-agents", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\/agents$/u, { pages: [] });
  push(committed(6));
  await expect(caret).toHaveCount(0);
  await expect(browser.getByTestId("page-now").getByRole("button", { name: /^claude:2/u })).toHaveCount(0);
});

test("everyday editing works as in Google Docs: rename the page, grow a table, links from typed URLs", async ({ page: browser }) => {
  await browser.setViewportSize({ width: 1280, height: 800 });
  // The page name differs from the opening heading, so the header still carries it, as plain text.
  await stubPages(browser, [page("p-relay", null, "Service", "V")]);
  await fixtureJson(browser, "page-links", /\/api\/xmatrix\/spaces\/[^/]+\/page-links\?.*$/u, { links: [] });
  await fixtureJson(browser, "page-rename", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay$/u,
    { page: page("p-relay", null, "Relay service", "V") }, { method: "PATCH" });
  const server = pageDocument("# Relay\n\n| Area | State |\n|---|---|\n| Search | Shipped |\n\nSee the notes.\n");
  const editor = await openLivePage(browser, server);

  // The title is the page's name, drawn as text: click, type, Enter. No field well.
  const title = browser.getByTestId("page-title");
  await expect(title).toHaveValue("Service");
  const titleChrome = await title.evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.borderTopWidth, background: style.backgroundColor, shadow: style.boxShadow, appearance: style.appearance };
  });
  expect(titleChrome.border, "the name has no box").toBe("0px");
  expect(titleChrome.shadow, "the name is not recessed").toBe("none");
  expect(titleChrome.background, "the name has no fill").toMatch(/transparent|rgba\(0,\s*0,\s*0,\s*0\)/u);
  expect(titleChrome.appearance, "the name is not a native field").toBe("none");
  await title.fill("Relay service");
  await title.press("Enter");
  await expect.poll(async () => fixtureRequestBodies(browser, "page-rename")).toEqual([{ title: "Relay service" }]);

  // In a table, its controls grow rows and columns. The rest of the page has no formatting toolbar.
  await expect(browser.getByTestId("page-toolbar")).toHaveCount(0);
  await editor.locator("td", { hasText: "Shipped" }).click();
  const toolbar = browser.getByTestId("page-table-tools");
  await toolbar.getByRole("button", { name: "Add a row below" }).click();
  await expect(editor.locator("tr")).toHaveCount(3);
  await toolbar.getByRole("button", { name: "Add a column to the right" }).click();
  await expect(editor.locator("tr").first().locator("th")).toHaveCount(3);

  // A typed URL becomes a link.
  await editor.getByText("See the notes.").click();
  await browser.keyboard.press("End");
  await browser.keyboard.type(" https://xmatrix.sh/docs ");
  await expect(editor.locator('a[href="https://xmatrix.sh/docs"]')).toBeVisible();
  await expect.poll(() => pageMarkdown(server)).toContain("See the notes. <https://xmatrix.sh/docs>\n");
  await expect.poll(() => pageMarkdown(server)).toMatch(/\| Search \| Shipped \| +\|\n\| +\| +\| +\|/u);
});

const PROMPT_FILE = {
  repository: "LambdaLabsHQ/xmatrix", path: "docs/prompts/bootstrap.md", ref: null, sha: "abc1234def5678", size: 210,
  htmlUrl: "https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/prompts/bootstrap.md",
  text: "# Startup prompt\n\nYou are running inside an xMatrix session.\n\n- Follow the [channel contract](contract.md).\n" +
    "- Keep responses concise.\n\n```sh\nxmatrix send <channel-id> \"<message>\"\n```\n",
  truncated: false,
};

test("a GitHub file the page embeds is drawn below its link, read through the Hub", async ({ page: browser }) => {
  await stubPages(browser, [page("p-relay", null, "Relay", "V")]);
  await fixtureJson(browser, "page-github-file", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay\/github-file\?href=/u,
    PROMPT_FILE);
  const editor = await openLivePage(browser,
    "# Relay\n\n## Startup prompt\n\n[bootstrap.md](xmatrix:github-file/LambdaLabsHQ/xmatrix/docs/prompts/bootstrap.md)\n");
  const card = editor.getByTestId("page-github-file");
  await expect(card).toContainText("LambdaLabsHQ/xmatrix / docs/prompts/bootstrap.md");
  await expect(card).toContainText("default branch · abc1234");
  await expect(card.locator("h1", { hasText: "Startup prompt" })).toBeVisible();
  await expect(card.locator("pre")).toContainText("xmatrix send <channel-id>");
  await expect(card.getByRole("link", { name: "channel contract" }), "links point where they do on GitHub")
    .toHaveAttribute("href", "https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/prompts/contract.md");
  await expect(card.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", PROMPT_FILE.htmlUrl);
  await browser.screenshot({ path: test.info().outputPath("pages-github-file.png") });
});

test("the insert menu embeds a pasted GitHub file link, and a refusal names what is missing", async ({ page: browser }) => {
  await stubPages(browser, [page("p-relay", null, "Relay", "V")]);
  await fixtureJson(browser, "page-github-file", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-relay\/github-file\?href=/u,
    { error: "Connect GitHub for this Space to show embedded files", code: "github_connection_required" }, { status: 409 });
  const server = pageDocument("# Relay\n\n## Prompts\n\nThe startup prompt:\n");
  const editor = await openLivePage(browser, server);
  await editor.getByText("The startup prompt:", { exact: true }).click();
  await browser.keyboard.press("End");
  await browser.keyboard.press("Enter");
  await browser.keyboard.type("/github");
  await expect(browser.getByTestId("page-insert-menu")).toContainText("GitHub file");
  await browser.keyboard.press("Enter");
  const form = browser.getByTestId("page-embed-github-file");
  await form.getByRole("textbox", { name: "GitHub file link" }).fill("https://github.com/LambdaLabsHQ/xmatrix/tree/main/docs");
  await form.getByRole("button", { name: "Embed" }).click();
  await expect(form, "a folder link is not a file").toContainText("Paste a file link");
  await form.getByRole("textbox", { name: "GitHub file link" })
    .fill("https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/prompts/bootstrap.md");
  await browser.screenshot({ path: test.info().outputPath("pages-github-file-insert.png") });
  await form.getByRole("button", { name: "Embed" }).click();
  await expect(form).toBeHidden();
  await expect.poll(() => pageMarkdown(server))
    .toContain("[bootstrap.md](xmatrix:github-file/LambdaLabsHQ/xmatrix/docs/prompts/bootstrap.md?ref=main)");
  await expect(editor.getByTestId("page-github-file")).toContainText("Connect GitHub for this Space to show this file.");
  await browser.screenshot({ path: test.info().outputPath("pages-github-file-refused.png") });
});
