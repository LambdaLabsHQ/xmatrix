import { IPHONE_USER_AGENT, recordListCorrections } from "./list-corrections";
import { fixtureChannelCatalog } from "./in-page-api-fixtures";
import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE, installWorkspaceStubs } from "./workspace-fixtures";

/* On iPhone, react-virtuoso holds a size correction it makes while the list
   scrolls as a top margin on the list, and scrolls it away once the reader
   stops; either one mid-flick blanks the list above a line cut through a row
   (user 2026-10-17). It corrects when a position's remembered size is wrong,
   which a list mixing section headings and rows got whenever a conversation
   moved into "Needs you". Scrolling back up over the moved positions must
   change nothing but the reader's own scroll. */

test.use({
  ...E2E_MOBILE_CONTEXT,
  userAgent: IPHONE_USER_AGENT,
});

const CHANNELS = Array.from({ length: 60 }, (_, index) => ({
  ...E2E_CHANNEL,
  id: `channel-${index}`,
  name: `conversation ${index}`,
  updatedAt: new Date(Date.parse(E2E_NOW) - index * 60_000).toISOString(),
  ...(index < 5 ? { attention: { unreadAttentionCount: 1 } } : {}),
}));

test("scrolling up after conversations move into Needs you writes no correction", async ({ page }) => {
  await recordListCorrections(page);
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: CHANNELS });
  await page.goto("/app/personal-sspaceperso/channels", { waitUntil: "domcontentloaded" });
  const pane = page.locator(".app-mobile-channel-list-pane");
  await expect(pane.getByText("conversation 3", { exact: true })).toBeVisible();

  // Three Recent conversations now wait on the reader and lead the list.
  await fixtureChannelCatalog(page, "catalog-needs-you", CHANNELS.map((channel, index) => (
    index >= 20 && index < 23
      ? { ...channel, attention: { unreadAttentionCount: 1 }, updatedAt: new Date(Date.parse(E2E_NOW) + 60_000).toISOString() }
      : channel
  )));
  const corrections = await page.evaluate(async (spaceId) => {
    const probe = window as unknown as { listCorrections: string[]; readerScrolling: boolean };
    const root = document.querySelector<HTMLElement>(".app-mobile-channel-list-pane .app-material-scroll-viewport")!;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const scrollTo = (top: number) => {
      probe.readerScrolling = true;
      root.scrollTop = top;
      probe.readerScrolling = false;
    };
    for (let top = 0; top <= 1500; top += 60) { scrollTo(top); await frame(); }
    probe.listCorrections.length = 0;
    for (let top = 1500; top >= 300; top -= 8) {
      if (top === 1460) {
        window.dispatchEvent(new CustomEvent("xmatrix:channel-catalog-change", { detail: { spaceId, kind: "structure" } }));
      }
      scrollTo(top);
      await frame();
    }
    return probe.listCorrections;
  }, E2E_SPACE.id);
  await expect(pane.getByText("Needs you8")).toBeVisible();
  expect(corrections).toEqual([]);
});
