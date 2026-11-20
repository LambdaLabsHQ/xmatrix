import { expect, test, type Locator, type Page } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_MOBILE_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  E2E_USER_SENDER,
  fixtureJson,
  fixtureRequests,
  fixtureRule,
  installPageTreeStubs,
  installWorkspaceStubs,
  releaseFixture,
} from "./workspace-fixtures";

const SLOW_HISTORY_RULE = "slow-channel-general-history";
const HELD_CATALOG_RULE = "held-channel-catalog";
const HELD_FLEET_CATALOG_RULE = "held-fleet-catalog";
const HELD_PAGE_TREE_RULE = "held-page-tree";
const HELD_PAGE_DOC_RULE = "held-page-doc";
const HELD_STARTUP_SESSION_RULE = "held-startup-session";

type Box = { left: number; top: number; width: number; height: number };

async function listRowBoxes(row: Locator, skeleton: boolean, titleSelector: string, metaSelector: string) {
  return {
    row: await box(row),
    title: skeleton ? await lineOf(row.locator(`${titleSelector} .app-skeleton-bar`)) : await box(row.locator(titleSelector)),
    meta: skeleton ? await lineOf(row.locator(`${metaSelector} .app-skeleton-bar`)) : await box(row.locator(metaSelector)),
  };
}

function expectSameTextOrigin(actual: Box, expected: Box, tolerance = 0.5) {
  expect(Math.abs(actual.left - expected.left)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.top - expected.top)).toBeLessThanOrEqual(tolerance);
}

async function waitForSettledAnimations(locator: Locator) {
  await expect.poll(() => locator.evaluate((element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.getAnimations().some((animation) => animation.pending || animation.playState === "running")) return false;
    }
    return true;
  })).toBe(true);
}

async function expectListSkeletonLanded(options: {
  page: Page;
  list: Locator;
  rowSelector: string;
  titleSelector: string;
  metaSelector: string;
  hashSelector?: string;
  firstLabel: string;
  release: () => Promise<void>;
}) {
  const { page, list, rowSelector, titleSelector, metaSelector, hashSelector, firstLabel, release } = options;
  await expect(list).toBeVisible();
  await waitForSettledAnimations(list);
  const skeletonRows = list.locator(rowSelector);
  const measure = async (row: Locator, skeleton: boolean) => ({
    ...(await listRowBoxes(row, skeleton, titleSelector, metaSelector)),
    hash: hashSelector ? await box(row.locator(hashSelector)) : null,
  });
  const skeleton = [await measure(skeletonRows.nth(0), true), await measure(skeletonRows.nth(2), true)];
  const skeletonHeading = await box(list.locator(".app-list-section-label"));

  await release();
  const rows = page.locator(`${rowSelector}:visible`);
  await expect(rows.filter({ hasText: firstLabel })).toBeVisible();
  await expect(list).toHaveCount(0);

  expectSameBox(skeletonHeading, await box(page.locator(".app-list-section-label:visible").first()));
  for (const [at, index] of [[0, 0], [1, 2]] as const) {
    const row = await measure(rows.nth(index), false);
    expectSameBox(skeleton[at].row, row.row);
    if (skeleton[at].hash && row.hash) expectSameBox(skeleton[at].hash, row.hash);
    expectSameTextOrigin(skeleton[at].title, row.title);
    expectSameTextOrigin(skeleton[at].meta, row.meta);
  }
}

function box(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
}

/** A skeleton's bar sits inside the line the text will; this is that line's box. */
function lineOf(bar: Locator): Promise<Box> {
  return box(bar.locator("xpath=.."));
}

/* A list that ends at the composer is placed by its scroll offset, which a
   phone rounds to its own pixel: allow that row a pixel, every other half. */
function expectSameBox(actual: Box, expected: Box, tolerance = 0.5) {
  for (const key of ["left", "top", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${key}: ${actual[key]} vs ${expected[key]}`).toBeLessThanOrEqual(tolerance);
  }
}

function history(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `skeleton-message-${index + 1}`,
    channelId: E2E_CHANNEL.id,
    sequence: index + 1,
    body: `Message ${index + 1}.`,
    sentAt: new Date(Date.parse(E2E_NOW) - (count - index) * 600_000).toISOString(),
    from: E2E_USER_SENDER,
  }));
}

async function openSlowHistory(page: Page, device: string, messageCount: number) {
  const channel = { ...E2E_CHANNEL, messageCount, historyHeadSequence: messageCount, updatedAt: E2E_NOW };
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
  /* Held open on purpose: the skeleton only exists while history is still in
     flight. `releaseFixture` lets it land. */
  await fixtureRule(page, {
    id: SLOW_HISTORY_RULE,
    pattern: "**/api/xmatrix/channels/channel-general/history**",
    responder: { kind: "deferred", json: { messages: history(messageCount), hasMore: false } },
  });
  if (device === "mobile") {
    await page.goto("/app/personal-sspaceperso/channels");
    await page.locator('[data-mobile-channel-row-id="channel-general"]').tap();
  } else {
    await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  }
  await expect.poll(async () => (await fixtureRequests(page, SLOW_HISTORY_RULE)).length).toBeGreaterThan(0);
  await expect(page.locator(".app-message-timeline-skeleton")).toBeVisible();
  // History stays held while the conversation slides in. Compare its loading
  // and loaded rows at rest, not at different points of that navigation.
  await waitForSettledAnimations(page.locator(".app-message-timeline-skeleton"));
}

/** What a message row places: itself, its avatar, its sender's line and its first line of text. */
async function messageRowBoxes(row: Locator, skeleton: boolean) {
  return {
    row: await box(row),
    avatar: await box(row.locator(".message-author-avatar")),
    name: skeleton
      ? await lineOf(row.locator(".app-message-author-name .app-skeleton-bar"))
      : await box(row.locator(".app-message-author-name")),
    text: skeleton
      ? await lineOf(row.locator(".rich-message p .app-skeleton-bar").first())
      : await box(row.locator(".rich-message p").first()),
  };
}

for (const [device, context] of [["desktop", E2E_DESKTOP_CONTEXT], ["mobile", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(device, () => {
    test.use(context);

    test("a history that fills the screen lands on its skeleton's last row", async ({ page }) => {
      await openSlowHistory(page, device, 40);
      const skeleton = await messageRowBoxes(page.locator(".app-message-skeleton-row").last(), true);

      await releaseFixture(page, SLOW_HISTORY_RULE);
      const last = page.locator(".app-message-timeline .app-message-row", { hasText: "Message 40." });
      await expect(last).toBeVisible();
      await expect(page.locator(".app-message-timeline-skeleton")).toHaveCount(0);
      await expect.poll(async () => Math.abs((await box(last)).top - skeleton.row.top)).toBeLessThanOrEqual(1);

      const message = await messageRowBoxes(last, false);
      expectSameBox(skeleton.row, message.row, 1);
      expectSameBox(skeleton.avatar, message.avatar, 1);
      expect(Math.abs(skeleton.name.left - message.name.left)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(skeleton.name.top - message.name.top)).toBeLessThanOrEqual(1);
      expectSameBox(skeleton.text, message.text, 1);
    });

    test("a history of two messages lands on its skeleton's two rows at the top", async ({ page }) => {
      await openSlowHistory(page, device, 2);
      const skeletonRows = page.locator(".app-message-skeleton-row");
      await expect(skeletonRows).toHaveCount(2);
      const skeleton = [await messageRowBoxes(skeletonRows.nth(0), true), await messageRowBoxes(skeletonRows.nth(1), true)];

      await releaseFixture(page, SLOW_HISTORY_RULE);
      const rows = page.locator(".app-message-timeline .app-message-row");
      await expect(rows.filter({ hasText: "Message 2." })).toBeVisible();
      await expect(page.locator(".app-message-timeline-skeleton")).toHaveCount(0);

      for (const index of [0, 1]) {
        const message = await messageRowBoxes(rows.nth(index), false);
        expectSameBox(skeleton[index].row, message.row);
        expectSameBox(skeleton[index].avatar, message.avatar);
        expectSameBox(skeleton[index].text, message.text);
      }
    });

    test("the conversation list lands on its skeleton's rows", async ({ page }) => {
      const channels = Array.from({ length: 3 }, (_, index) => ({
        ...E2E_CHANNEL,
        id: `channel-skeleton-${index}`,
        name: `skeleton-${index}`,
        updatedAt: E2E_NOW,
        lastMessage: { from: E2E_USER_SENDER, bodyPreview: "What was said last", sentAt: E2E_NOW },
      }));
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels });
      /* Held open on purpose: the list's skeleton only exists while its first
         catalog page is still in flight. */
      await fixtureRule(page, {
        id: HELD_CATALOG_RULE,
        pattern: /\/api\/xmatrix\/channels\/(?:page|resolve)(?:\?.*)?$/,
        responder: { kind: "channelCatalog", channels, held: true },
      });
      await page.goto("/app/personal-sspaceperso/channels", { waitUntil: "domcontentloaded" });
      // The startup frame paints the same skeleton; measure the shell's own.
      await page.locator(".xmatrix-app-shell:not([aria-busy])").waitFor();

      await expectListSkeletonLanded({
        page,
        list: page.getByRole("status", { name: "Loading channels" }).locator("visible=true"),
        rowSelector: ".app-channel-chat-row",
        titleSelector: ".app-channel-row-name",
        metaSelector: ".app-channel-row-preview",
        hashSelector: ".app-channel-row-hash",
        firstLabel: "skeleton-0",
        release: () => releaseFixture(page, HELD_CATALOG_RULE),
      });
    });

    test("the status page startup frame and loading skeleton match its matrix layout", async ({ page }) => {
      await page.addInitScript(() => {
        (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true;
      });
      const registration = (machineId: string, machineName: string, harness: string) => ({
        key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId, harness },
        displayName: harness,
        ownerName: "E2E Tester",
        machineName,
        version: 1,
        state: "enabled",
        models: [],
        routingReady: true,
        canManageOwnerGrant: false,
        canConfigureSpace: false,
        canRemoveFromSpace: false,
        live: { machine: { online: true, lastSeenAt: E2E_NOW, platform: "linux" }, running: [] },
      });
      const registrations = [
        registration("machine:alpha", "alpha-box", "claude"),
        registration("machine:alpha", "alpha-box", "codex"),
        registration("machine:beta", "beta-box", "claude"),
        registration("machine:beta", "beta-box", "codex"),
      ];
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
      await fixtureRule(page, {
        id: HELD_STARTUP_SESSION_RULE,
        pattern: "**/api/auth/get-session**",
        responder: {
          kind: "deferred",
          json: {
            user: { id: "e2e-user", email: "e2e@xmatrix.test", name: "E2E Tester" },
            session: { token: "status-skeleton-session", expiresAt: "2099-01-01T00:00:00.000Z" },
          },
          headers: { "set-auth-jwt": "status-skeleton-jwt" },
        },
      });
      await fixtureRule(page, {
        id: HELD_FLEET_CATALOG_RULE,
        pattern: /\/api\/xmatrix\/spaces\/[^/]+\/agent-registrations(?:\?.*)?$/u,
        responder: {
          kind: "deferred",
          json: {
            registrations,
            capabilities: ["claude", "codex"].map((harness) => ({
              harness,
              models: [],
              locations: registrations.filter((item) => item.key.harness === harness),
            })),
          },
        },
      });

      await page.goto("/app/personal-sspaceperso/status", { waitUntil: "domcontentloaded" });
      await expect.poll(async () => (await fixtureRequests(page, HELD_STARTUP_SESSION_RULE)).length).toBeGreaterThan(0);

      // Phase 1: StartupShell matches the Status / Agents layout, never the Channels sidebar or list.
      const startup = page.locator(".xmatrix-app-shell[aria-busy=true]");
      await expect(startup).toBeVisible();
      await expect(startup.getByRole("status", { name: "Loading channels" })).toHaveCount(0);
      const startupSkeleton = startup.getByRole("status", { name: "Loading machines and agents" }).locator("visible=true");
      await expect(startupSkeleton).toBeVisible();
      if (device === "desktop") {
        await expect(startup.locator(".app-sidebar:visible")).toHaveCount(0);
        await expect(startup.getByRole("heading", { level: 1, name: "System Overview" })).toBeVisible();
      } else {
        await expect(startup.getByRole("button", { name: "Agents", exact: true })).toHaveAttribute("aria-current", "page");
      }

      // Phase 2: Signed-in FleetView keeps the exact same matrix skeleton while its catalog loads.
      await releaseFixture(page, HELD_STARTUP_SESSION_RULE);
      await expect(startup).toHaveCount(0);
      const liveSkeleton = page.getByRole("status", { name: "Loading machines and agents" }).locator("visible=true");
      await expect(liveSkeleton).toBeVisible();
      const skeletonBox = await box(liveSkeleton);
      const skeletonHeader = device === "desktop"
        ? await box(page.locator(".app-status-hero:visible"))
        : null;
      const skeletonRow = device === "desktop"
        ? await box(liveSkeleton.locator("tbody tr").first())
        : await box(liveSkeleton.locator("section").first());

      // Phase 3: Real matrix lands on the skeleton's position and row geometry.
      await releaseFixture(page, HELD_FLEET_CATALOG_RULE);
      const matrix = page.getByTestId("fleet-matrix").locator("visible=true");
      await expect(matrix).toBeVisible();
      await expect(liveSkeleton).toHaveCount(0);

      if (device === "desktop") {
        expectSameBox(skeletonHeader!, await box(page.locator(".app-status-hero:visible")), 1);
        const liveMatrixBox = await box(matrix);
        expect(Math.abs(skeletonBox.left - liveMatrixBox.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(skeletonBox.top - liveMatrixBox.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(skeletonBox.width - liveMatrixBox.width)).toBeLessThanOrEqual(1);
        const liveRow = await box(matrix.locator("tbody tr[data-testid='fleet-machine']").first());
        expect(Math.abs(skeletonRow.top - liveRow.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(skeletonRow.height - liveRow.height)).toBeLessThanOrEqual(2);
      } else {
        const liveRow = await box(matrix.locator("section[data-testid='fleet-machine']").first());
        expect(Math.abs(skeletonRow.left - liveRow.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(skeletonRow.width - liveRow.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(skeletonRow.height - liveRow.height)).toBeLessThanOrEqual(2);
      }
    });

    test("the pages list lands on its skeleton's rows", async ({ page }) => {
      await installPageTreeStubs(page, ["Architecture", "Roadmap", "Design"]);
      const pages = ["Architecture", "Roadmap", "Design"].map((title, index) => ({
        pageId: `page-skeleton-${index}`,
        parentPageId: null,
        title,
        position: String.fromCharCode(65 + index),
        accessMode: "open",
        headRevision: 1,
        agentSuggestOnly: false,
        canEdit: true,
        updatedAt: E2E_NOW,
      }));
      await fixtureRule(page, {
        id: HELD_PAGE_TREE_RULE,
        pattern: /\/api\/xmatrix\/spaces\/[^/]+\/pages(?:\?.*)?$/u,
        responder: { kind: "deferred", json: { pages } },
      });
      await fixtureJson(page, "page-recent-empty", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/recent-changes(?:\?.*)?$/u, {
        changes: [],
      });
      await fixtureRule(page, {
        id: HELD_PAGE_DOC_RULE,
        pattern: /\/api\/xmatrix\/spaces\/[^/]+\/pages\/page-skeleton-0(?:\?.*)?$/u,
        responder: {
          kind: "deferred",
          json: {
            page: {
              ...pages[0],
              body: "# Architecture\n\nShared skeleton geometry.",
            },
          },
        },
      });

      await page.goto("/app/personal-sspaceperso/pages", { waitUntil: "domcontentloaded" });
      await page.locator(".xmatrix-app-shell:not([aria-busy])").waitFor();

      const docSkeleton = device === "desktop"
        ? page.getByRole("status", { name: "Loading page", exact: true }).locator("visible=true")
        : null;
      let docSkeletonBox: Box | null = null;
      if (docSkeleton) {
        await expect(docSkeleton).toBeVisible();
        docSkeletonBox = await box(docSkeleton);
      }

      await expectListSkeletonLanded({
        page,
        list: page.getByRole("status", { name: "Loading pages" }).locator("visible=true"),
        rowSelector: ".app-page-row",
        titleSelector: ".app-page-row-title",
        metaSelector: ".app-list-row-meta",
        firstLabel: "Architecture",
        release: () => releaseFixture(page, HELD_PAGE_TREE_RULE),
      });

      if (docSkeletonBox) {
        await releaseFixture(page, HELD_PAGE_DOC_RULE);
        const preview = page.getByTestId("page-preview");
        await expect(preview).toBeVisible();
        const previewBox = await box(preview);
        expect(Math.abs(docSkeletonBox.left - previewBox.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(docSkeletonBox.width - previewBox.width)).toBeLessThanOrEqual(1);
      }
    });
  });
}
