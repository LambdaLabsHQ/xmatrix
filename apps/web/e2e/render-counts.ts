import type { Page } from "@playwright/test";

/** Count committed component work without introducing timers or test-only product seams. */
export async function installRenderCounter(page: Page) {
  await page.addInitScript(() => {
    type Fiber = {
      tag: number;
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
      memoizedProps: Record<string, unknown> | null;
    };
    const counts = { navRows: 0, messageRows: 0, workspaceViews: 0, commits: 0, counting: false };
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
              if ("model" in props) counts.workspaceViews += 1;
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
}
