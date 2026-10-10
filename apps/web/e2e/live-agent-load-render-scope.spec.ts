import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, conversationOpened } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const CHANNEL_COUNT = 40;
const space = workingAgentsSpace(CHANNEL_COUNT, "load");
const messages = channelHistory(40, "load-message", (row) => `Load row ${row}: a **status** update with \`code\`.`);

/**
 * Dozens of Agents working at once stream presence and activity for every
 * conversation. Each report must re-render what it concerns - its own
 * conversation's row - and leave the open conversation's messages alone.
 * Rendering the whole list and every visible message (Markdown included) per
 * report is what made a busy Space stutter in the desktop app. React commits
 * are counted through the DevTools hook, so host speed cannot move the result.
 */
test("Agents working in other conversations re-render only their own rows", async ({ page }) => {
  await page.addInitScript(() => {
    type Fiber = {
      tag: number;
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
      memoizedProps: Record<string, unknown> | null;
    };
    const counts = { navRows: 0, messageRows: 0, commits: 0, counting: false };
    (window as unknown as { __renderCounts: typeof counts }).__renderCounts = counts;
    // What React DevTools reads: a function component ran in this commit when
    // it carries PerformedWork (1). A subtree React bailed out of keeps its old
    // fibers, flags included, so it is skipped: its child is its alternate's.
    const PERFORMED_WORK = 1;
    (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject() { return 1; },
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        if (!counts.counting) return;
        counts.commits += 1;
        const visit = (fiber: Fiber | null) => {
          for (let node = fiber; node; node = node.sibling) {
            const props = node.memoizedProps;
            // Function components only: the row bodies, not their memo wrappers.
            if (node.tag === 0 && props && (node.flags & PERFORMED_WORK)) {
              if ("isPinnedRoot" in props && "onSelect" in props) counts.navRows += 1;
              if ("message" in props && "onRetryAgentLaunch" in props) counts.messageRows += 1;
            }
            if (!node.alternate || node.child !== node.alternate.child) visit(node.child);
          }
        };
        visit(root.current.child);
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    };
  });
  const send = await openWorkingAgentsSpace(page, space, messages, "Load row 40:");
  // The last conversation is below the fold: the list only mounts rows near the viewport.
  await expect(page.locator(`[data-channel-row-id="${space.channelId(1)}"]`)).toBeVisible();
  await conversationOpened(page);

  await page.evaluate(() => {
    (window as unknown as { __renderCounts: { counting: boolean } }).__renderCounts.counting = true;
  });
  const reports = CHANNEL_COUNT - 1;
  for (let index = 1; index <= reports; index += 1) {
    const activity = `Running step ${index}`;
    // The Agent card alone: the whole-Channel frame also moves the
    // conversation's catalog row, which is not what this counts.
    const [card] = space.report(index, activity);
    send(card);
    // Reports arrive spread out, as they do from working Agents, not batched into one commit.
    await page.waitForTimeout(20);
  }
  // Frames are applied as they arrive; give the last ones a moment to commit.
  await page.waitForTimeout(500);
  const counts = await page.evaluate(() =>
    (window as unknown as { __renderCounts: { navRows: number; messageRows: number; commits: number } }).__renderCounts);
  console.log(`[live-agent-load] ${reports} reports: ${JSON.stringify(counts)}`);

  expect(counts.commits).toBeGreaterThan(0);
  // The open conversation is none of theirs: its messages never re-render.
  expect(counts.messageRows).toBe(0);
  // Each report touches its own row; the other 39 stay as they were.
  expect(counts.navRows).toBeLessThanOrEqual(reports * 2);
});
