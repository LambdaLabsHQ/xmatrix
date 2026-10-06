import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequests, fixtureRule } from "./in-page-api-fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, installWorkspaceStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const INSTANCE_ID = "instance-codex-1";
const TRACE_PATH = `/api/xmatrix/trace/instances/${INSTANCE_ID}/events`;
const OLDER_CURSOR = "2026-07-01T00:00:10.000Z|trace-10";

const TRACE_CHANNEL = {
  ...E2E_CHANNEL,
  memberPresence: {
    "agent:codex": {
      kind: "agent",
      status: "busy",
      label: "Codex",
      activity: "Paging trace",
      instances: [{
        id: INSTANCE_ID,
        channelInstanceId: "1",
        label: "codex:1",
        connectedAt: E2E_NOW,
        lastSeenAt: E2E_NOW,
        status: "busy",
        activity: "Paging trace",
      }],
    },
  },
};

/* One tool call per step, so every event is its own timeline item. */
function traceEvent(step: number) {
  const id = `trace-${step}`;
  return {
    id,
    type: "event_published",
    channelId: E2E_CHANNEL.id,
    agentId: "agent:codex",
    agentName: "Codex",
    timestamp: new Date(Date.parse(E2E_NOW) + step * 1_000).toISOString(),
    metadata: {
      eventType: "llm_trace",
      payload: {
        channelId: E2E_CHANNEL.id,
        agent: { id: "agent:codex", instanceId: INSTANCE_ID },
        phase: "tool_call",
        payload: { name: `paging_step_${step}`, arguments: { step } },
      },
    },
  };
}

function page_(steps: number[], nextCursor: string | null) {
  return {
    availability: "available",
    complete: nextCursor === null,
    events: steps.map(traceEvent),
    cursor: null,
    nextCursor,
  };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

async function openTrace(page: Page) {
  const avatar = page.getByRole("button", { name: /Open Codex.*codex:1/ });
  await expect(avatar).toBeVisible();
  await avatar.click();
}

test("the trace opens on the newest page and loads earlier pages on demand", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [TRACE_CHANNEL] });
  await fixtureJson(page, "legacy-trace-grants", /\/api\/xmatrix\/trace\/access-requests(?:[/?]|$)/u,
    { error: "Legacy grant service is unavailable" }, { status: 503 });
  // Later rules win: the base read is the newest page, `before` is the older
  // page, and live `since` deltas have nothing new.
  await fixtureJson(page, "trace-newest", new RegExp(`${TRACE_PATH}\\?(?!.*before=)`, "u"),
    page_(range(10, 14), OLDER_CURSOR));
  await fixtureJson(page, "trace-older", new RegExp(`${TRACE_PATH}\\?.*before=`, "u"),
    page_(range(1, 9), null));
  await fixtureJson(page, "trace-since", new RegExp(`${TRACE_PATH}\\?.*since=`, "u"),
    page_([], null));
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });

  await openTrace(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("paging_step_14").first()).toBeVisible();
  await expect(dialog.getByText("paging_step_10").first()).toBeAttached();
  await expect(dialog.getByText("paging_step_9", { exact: true })).toHaveCount(0);
  // A loadable earlier page is not reported as missing history.
  await expect(dialog.getByText("Only recent trace history is available")).toHaveCount(0);

  const loadEarlier = dialog.getByRole("button", { name: "Load earlier trace" });
  await expect(loadEarlier).toBeVisible();
  await loadEarlier.click();

  await expect(dialog.getByText("paging_step_1", { exact: true })).toBeAttached();
  await expect(loadEarlier).toHaveCount(0);
  for (const step of range(1, 14)) {
    await expect(dialog.getByText(`paging_step_${step}`, { exact: true })).toHaveCount(1);
  }
  const olderReads = await fixtureRequests(page, "trace-older");
  expect(olderReads.length).toBeGreaterThanOrEqual(1);
  for (const url of olderReads) {
    expect(new URL(url).searchParams.get("before")).toBe(OLDER_CURSOR);
  }
  expect(await fixtureRequests(page, "legacy-trace-grants")).toHaveLength(0);
});

test("a denied trace says who can view it instead of an unverifiable-access notice", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [TRACE_CHANNEL] });
  await fixtureJson(page, "trace-denied", new RegExp(`${TRACE_PATH}\\?`, "u"),
    { error: "Agent trace access denied", code: "trace_access_denied" }, { status: 403 });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });

  await openTrace(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("You cannot view this trace")).toBeVisible();
  await expect(dialog.getByText("Trace access could not be verified")).toHaveCount(0);
});

test("a live authorization denial clears previously visible trace events", async ({ page }) => {
  const dialog = await openTraceWithSteps(page, [1]);
  await expect(dialog.getByText("paging_step_1", { exact: true })).toBeVisible();
  await fixtureJson(page, "trace-revoked", new RegExp(`${TRACE_PATH}\\?.*since=`, "u"),
    { error: "Agent trace access denied", code: "trace_access_denied" }, { status: 403 });

  await expect(dialog.getByText("You cannot view this trace")).toBeVisible();
  await expect(dialog.getByText("paging_step_1", { exact: true })).toHaveCount(0);
});

test("the first page loads behind a skeleton and a failed live read does not blank the trace", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [TRACE_CHANNEL] });
  await fixtureJson(page, "trace-head", new RegExp(`${TRACE_PATH}\\?(?!.*since=)`, "u"),
    page_(range(10, 14), OLDER_CURSOR), { delayMs: 1_500 });
  // The first live read fails the way a busy host or a Hub hiccup does.
  await fixtureRule(page, {
    id: "trace-since",
    pattern: new RegExp(`${TRACE_PATH}\\?.*since=`, "u"),
    responder: { kind: "sequence", responses: [
      { status: 503, json: { error: "Agent host trace request failed", code: "trace_host_invalid" } },
      { status: 200, json: page_([], null) },
    ] },
  });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });

  await openTrace(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status", { name: "Loading trace" })).toBeVisible();
  await expect(dialog.getByText("Trace history lives on the Agent host")).toHaveCount(0);

  const newest = dialog.getByText("paging_step_14", { exact: true });
  await expect(newest).toBeVisible();
  await expect(dialog.getByRole("status", { name: "Loading trace" })).toHaveCount(0);
  // Sample through the failed read and the recovery after it.
  const samples: number[] = [];
  for (let tick = 0; tick < 30; tick += 1) {
    samples.push(await newest.count());
    await page.waitForTimeout(100);
  }
  expect(await fixtureRequests(page, "trace-since")).not.toHaveLength(0);
  expect(samples.every((count) => count === 1)).toBe(true);
  await expect(dialog.getByText("Live", { exact: true })).toBeVisible();
});

const TRACE_SCROLLER = "[data-agent-instance-scroll]";

/** Opens the trace on one complete head page with nothing new live yet. */
async function openTraceWithSteps(page: Page, steps: number[]) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [TRACE_CHANNEL] });
  await fixtureJson(page, "trace-head", new RegExp(`${TRACE_PATH}\\?(?!.*since=)`, "u"), page_(steps, null));
  await fixtureJson(page, "trace-since", new RegExp(`${TRACE_PATH}\\?.*since=`, "u"), page_([], null));
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  await openTrace(page);
  return page.getByRole("dialog");
}

test("a long trace opens at its newest step and holds the reader's place while live steps land", async ({ page }) => {
  const dialog = await openTraceWithSteps(page, range(1, 60));
  await expect(dialog.getByText("paging_step_60", { exact: true })).toBeInViewport();

  // The reader scrolls up to an earlier step.
  const scroller = dialog.locator(TRACE_SCROLLER);
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight / 3; });
  await expect(dialog.getByText("paging_step_60", { exact: true })).not.toBeInViewport();
  const readingAt = await scroller.evaluate((element) => element.scrollTop);

  // A live step lands below; the view does not move under them.
  await fixtureJson(page, "trace-live", new RegExp(`${TRACE_PATH}\\?.*since=`, "u"), page_([61], null));
  const jump = dialog.getByRole("button", { name: "New activity" });
  await expect(jump).toBeVisible();
  await expect(dialog.getByText("paging_step_61", { exact: true })).toBeAttached();
  expect(Math.abs(await scroller.evaluate((element) => element.scrollTop) - readingAt)).toBeLessThan(2);

  await jump.click();
  await expect(dialog.getByText("paging_step_61", { exact: true })).toBeInViewport();
  await expect(jump).toHaveCount(0);
});

test("a large trace mounts its newest steps first and reveals earlier ones in place", async ({ page }) => {
  // A full head page; the client mounts the newest 80 of its 100 steps.
  const dialog = await openTraceWithSteps(page, range(1, 100));
  await expect(dialog.getByText("paging_step_100", { exact: true })).toBeInViewport();
  await expect(dialog.getByText("paging_step_21", { exact: true })).toBeAttached();
  await expect(dialog.getByText("paging_step_20", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Show earlier steps" })).toBeAttached();

  // Scrolling to the top reveals the rest above, without moving the view.
  const scroller = dialog.locator(TRACE_SCROLLER);
  const before = await scroller.evaluate((element) => {
    element.scrollTop = 0;
    const step = [...element.querySelectorAll("span")].find((node) => node.textContent === "paging_step_21");
    return step!.getBoundingClientRect().top;
  });
  await expect(dialog.getByText("paging_step_1", { exact: true })).toBeAttached();
  await expect(dialog.getByRole("button", { name: "Show earlier steps" })).toHaveCount(0);
  const after = await dialog.getByText("paging_step_21", { exact: true })
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(after - before)).toBeLessThan(2);
});
