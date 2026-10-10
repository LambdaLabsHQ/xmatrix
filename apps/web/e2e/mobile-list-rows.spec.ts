import { expect, test, type Locator, type Page } from "./fixtures";
import { fixtureJson } from "./in-page-api-fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE, installWorkspaceStubs } from "./workspace-fixtures";

/* A phone's lists are a desktop's lists: the same 56px row, its title and
   the line under it in the same type, on the same tone. The plank and the
   rows run edge to edge; their content keeps to one content line, 16px
   from the screen's edges: the plank's sign and a row's leading mark start
   on it, the plank's search glyph and a row's trailing time or + end on it. */

const REGISTRATIONS = [{ key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "mac-id", harness: "codex" },
  displayName: "codex", machineName: "My Mac", models: [] }];

async function installLists(page: Page, spaces: unknown[] = [E2E_SPACE]) {
  await installWorkspaceStubs(page, { spaces, channels: [E2E_CHANNEL], registrations: REGISTRATIONS } as never);
  await fixtureJson(page, "page-tree", /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u, {
    pages: [{ pageId: "p-home", parentPageId: null, title: "Home", position: "V", accessMode: "open", headRevision: 1,
      agentSuggestOnly: false, canEdit: true, updatedAt: E2E_NOW }],
  });
}

type Edges = { left: number; right: number };

/** Measures once a screen has finished sliding in. */
async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
}

/** An element's box, or the box of the text it holds, which is where its letters sit. */
function edges(locator: Locator, { text = false } = {}): Promise<Edges> {
  return locator.evaluate((element, ofText) => {
    let box = element.getBoundingClientRect();
    if (ofText) {
      const range = document.createRange();
      range.selectNodeContents(element);
      box = range.getBoundingClientRect();
    }
    return { left: box.left, right: box.right };
  }, text);
}

/** The content line's inset from the screen's edges, and the sign's own padding before its glyph. */
const CONTENT_INSET = 16;
const SIGN_PADDING = 14;

/** The bar's content line: where the Space sign's wood starts and its trailing search glyph ends. */
async function contentLine(page: Page) {
  await settled(page);
  const bar = page.locator(".app-topbar");
  const [plank, name, search, width] = await Promise.all([edges(bar),
    edges(bar.locator("svg.app-mobile-space-glyph")), edges(bar.locator(".app-mobile-search-icon svg")),
    page.evaluate(() => window.innerWidth)]);
  // The bar spans the screen; its wood is only the Space sign, whose edge sits on the line.
  expect(plank.left).toBe(0);
  expect(plank.right).toBe(width);
  expect(name.left).toBeCloseTo(CONTENT_INSET + SIGN_PADDING, 0);
  expect(width - search.right).toBeCloseTo(CONTENT_INSET, 0);
  return { plank, start: name.left - SIGN_PADDING, end: search.right };
}

type RowMeasure = { height: number; inset: number; title: string[]; meta: string[]; listTone: string };

function measure(row: Locator): Promise<RowMeasure> {
  return row.evaluate((element) => {
    const type = (selector: string) => {
      const style = getComputedStyle(element.querySelector(selector)!);
      return [style.fontSize, style.fontWeight, style.lineHeight];
    };
    const box = element.getBoundingClientRect();
    const titleBox = element.querySelector(".app-list-row-title")!.getBoundingClientRect();
    // The list's tone: the nearest ancestor that paints one.
    let list: Element | null = element.parentElement;
    while (list && getComputedStyle(list).backgroundColor === "rgba(0, 0, 0, 0)") list = list.parentElement;
    return { height: Math.round(box.height), inset: Math.round(titleBox.left - box.left), title: type(".app-list-row-title"),
      meta: type(".app-list-row-meta"), listTone: list ? getComputedStyle(list).backgroundColor : "" };
  });
}

async function desktopConversationRow(page: Page) {
  await page.setViewportSize(E2E_DESKTOP_CONTEXT.viewport);
  await page.goto(`/app/${encodeURIComponent(E2E_SPACE.id)}/channels/${encodeURIComponent(`${E2E_CHANNEL.name}--${E2E_CHANNEL.id}`)}`,
    { waitUntil: "domcontentloaded" });
  const conversation = page.locator(".app-sidebar .app-channel-chat-row").first();
  await expect(conversation).toBeVisible();
  return measure(conversation);
}

test.describe("a phone's list rows", () => {
  test.use(E2E_MOBILE_CONTEXT);

  for (const intent of [undefined, "Check CI"]) {
    test(`show the latest message while Agents work ${intent ? "with" : "without"} a reported step`, async ({ page }, testInfo) => {
      const now = new Date().toISOString();
      const channel = {
        ...E2E_CHANNEL,
        members: ["agent:codex"],
        lastMessage: { from: { kind: "user", label: "Yiming" }, bodyPreview: "Keep the message preview", sentAt: now },
        memberPresence: { "agent:codex": { kind: "agent", label: "codex", instances: [1, 2].map(id => ({
          id: `instance-${id}`, channelInstanceId: String(id), label: `codex:${id}`, channelId: E2E_CHANNEL.id,
          connectedAt: now, lastSeenAt: now, status: "busy", intent,
          runtimeState: { status: "running", activeChannelId: E2E_CHANNEL.id },
        })) } },
      };
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
      for (const [layout, viewport] of [["phone", E2E_MOBILE_CONTEXT.viewport], ["desktop", E2E_DESKTOP_CONTEXT.viewport]] as const) {
        await page.setViewportSize(viewport);
        await page.goto("/app/personal-sspaceperso/channels", { waitUntil: "domcontentloaded" });
        const row = page.locator(layout === "phone" ? ".app-mobile-chat-row" : ".app-sidebar .app-channel-chat-row").first();
        await expect(row).toBeVisible();
        await expect(row.locator(".app-channel-row-preview")).toHaveText("Yiming: Keep the message preview");
        await expect(row.locator(".app-channel-agent-avatar")).toHaveCount(2);
        await expect(row.locator(".identity-avatar-status")).toHaveCount(2);
        await testInfo.attach(`${layout}-message-preview`, { body: await row.screenshot(), contentType: "image/png" });
      }
    });
  }

  test("are the desktop's rows, edge to edge with content on the plank's line", async ({ page }) => {
    await installLists(page);
    await page.goto("/app", { waitUntil: "domcontentloaded" });
    const conversation = page.locator(".app-mobile-chat-row").first();
    await expect(conversation).toBeVisible();
    const line = await contentLine(page);

    const phone = await measure(conversation);
    const paper = await conversation.evaluate((element) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--app-panel-paper)";
      element.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    expect(phone.height).toBe(56);
    expect(phone.title).toEqual(["16px", "620", "22px"]);
    expect(phone.meta).toEqual(["13px", "450", "18px"]);
    // Square, and as wide as the plank above it: the screen.
    const row = await edges(conversation);
    expect(row.left).toBeCloseTo(line.plank.left, 0);
    expect(row.right).toBeCloseTo(line.plank.right, 0);
    expect(await conversation.evaluate((element) => getComputedStyle(element).borderTopLeftRadius)).toBe("0px");
    // Its # under the plank's name, its time under the search glyph.
    expect((await edges(conversation.locator(".app-channel-row-hash"), { text: true })).left).toBeCloseTo(line.start, 0);
    expect((await edges(conversation.locator(".app-channel-row-time"), { text: true })).right).toBeCloseTo(line.end, 0);

    const dock = page.getByRole("navigation", { name: "Primary" });
    await dock.getByRole("button", { name: "Pages" }).tap();
    const pageRow = page.getByTestId("page-list").locator(".app-page-row", { hasText: "Home" });
    await expect(pageRow).toBeVisible();
    await settled(page);
    const pageMeasure = await measure(pageRow);
    expect(pageMeasure.height).toBe(56);
    expect(pageMeasure.title).toEqual(phone.title);
    expect(pageMeasure.meta).toEqual(phone.meta);
    await expect(pageRow.locator(".app-list-row-meta")).toHaveText(/^Edited /u);
    // The chevron on the line, the page's icon after it; the row's own +,
    // shown on a touch screen that has no hover, at the line's end.
    const create = pageRow.getByRole("button", { name: "New sub-page" });
    await expect(create).toHaveCSS("opacity", "1");
    const chevron = await edges(pageRow.locator(":scope > button svg").first());
    expect(chevron.left).toBeGreaterThanOrEqual(line.start - 0.5);
    expect(chevron.left).toBeLessThan(line.start + 10);
    expect((await edges(pageRow.locator(".app-page-row-title-line svg").first())).left).toBeGreaterThanOrEqual(chevron.right);
    expect((await edges(create.locator("svg"))).right).toBeCloseTo(line.end, 0);

    await dock.getByRole("button", { name: "More" }).tap();
    await page.getByRole("button", { name: /^Agents/u }).first().tap();
    const heading = page.locator(".app-tool-list-group-title").first();
    const machine = page.locator(".app-tool-list-row").first();
    await expect(machine).toBeVisible();
    await settled(page);
    expect((await measure(machine)).height).toBe(56);
    expect((await edges(heading)).left).toBeCloseTo(line.plank.left, 0);
    expect((await edges(heading.locator(":scope > *").first())).left).toBeCloseTo(line.start, 0);
    expect((await edges(heading.locator(":scope > span").last(), { text: true })).right).toBeCloseTo(line.end, 0);

    // The same row a desktop draws. A phone never shows its list beside a
    // conversation, so the list is the conversation's paper, not the column's tone.
    const desktop = await desktopConversationRow(page);
    expect(phone).toEqual({ ...desktop, inset: phone.inset, listTone: phone.listTone });
    expect(phone.listTone).toBe(paper);
    expect(desktop.listTone).not.toBe(paper);
    // The measured title begins after the # and its gap. Only the row's
    // padding changes: 20px on desktop, the shared content line on phone.
    expect(phone.inset).toBe(Math.round(desktop.inset + line.start - 20));
  });

  test("keep to the line under a Space switcher and under a pushed screen's back chevron", async ({ page }) => {
    // Spaces are listed by name; the second sorts after the one holding the conversations.
    await installLists(page, [E2E_SPACE, { ...E2E_SPACE, id: "space-team", name: "Team" }]);
    await page.goto("/app", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Switch workspace" })).toBeVisible();
    const line = await contentLine(page);
    await expect(page.locator(".app-mobile-chat-row").first()).toBeVisible();
    expect((await edges(page.locator(".app-mobile-chat-row .app-channel-row-hash").first(), { text: true })).left)
      .toBeCloseTo(line.start, 0);

    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "More" }).tap();
    await page.getByRole("button", { name: /^Settings/u }).first().tap();
    const bar = page.locator(".app-topbar");
    const back = bar.getByRole("button", { name: "Back to More" });
    await expect(back).toBeVisible();
    await expect(page.locator(".app-tool-list-row").first()).toBeVisible();
    await settled(page);
    const [plank, sign, search, width] = await Promise.all([edges(bar), edges(bar.locator(".app-mobile-back-sign")),
      edges(bar.locator(".app-mobile-search-icon svg")), page.evaluate(() => window.innerWidth)]);
    // The chevron is cut into the title's sign, which starts where the Space sign does.
    await expect(bar.locator(".app-mobile-back-sign").getByRole("button", { name: "Back to More" })).toBeVisible();
    expect(sign.left).toBeCloseTo(line.start, 0);
    expect(width - search.right).toBeCloseTo(CONTENT_INSET, 0);
    const setting = page.locator(".app-tool-list-row").first();
    await expect(setting).toBeVisible();
    // The pushed screen slides in under the bar; read it where it comes to rest.
    await expect.poll(async () => Math.round((await edges(setting)).left - plank.left)).toBe(0);
    expect((await edges(setting.locator("svg").first())).left).toBeCloseTo(line.start, 0);
  });
  test("carry who is here as 20px faces on the second line, under a time centred on the title line", async ({ page }) => {
    const presence = Object.fromEntries([0, 1, 2, 3].map((index) => [`agent:codex-${index}`, { kind: "agent", status: "busy",
      label: `Codex ${index}`, instances: [{ id: `instance-codex-${index}`, channelInstanceId: `${index + 1}`,
        label: `codex:${index + 1}`, connectedAt: E2E_NOW, lastSeenAt: E2E_NOW, status: "busy" }] }]));
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [{ ...E2E_CHANNEL, memberPresence: presence }] } as never);
    await page.goto("/app", { waitUntil: "domcontentloaded" });
    const row = page.locator(".app-mobile-chat-row").first();
    const faces = row.locator(".app-channel-agent-avatars :is(.identity-avatar-face, .app-channel-presence-overflow)");
    await expect(faces).toHaveCount(4);
    const [time, line, title] = await Promise.all([row.locator(".app-channel-row-time").boundingBox(),
      row.locator(".app-channel-row-preview-line").boundingBox(), row.locator(".app-channel-row-title-line").boundingBox()]);
    // The time sits in the middle of the title line, not down on its baseline next to the faces.
    expect(time!.y + time!.height / 2).toBeCloseTo(title!.y + title!.height / 2, 0);
    for (const face of await faces.all()) {
      const box = (await face.boundingBox())!;
      expect(Math.round(box.width)).toBe(20);
      expect(Math.round(box.height)).toBe(20);
      expect(box.y).toBeGreaterThanOrEqual(time!.y + time!.height);
      expect(box.y + box.height).toBeLessThanOrEqual(line!.y + line!.height + 1);
    }
  });
});
