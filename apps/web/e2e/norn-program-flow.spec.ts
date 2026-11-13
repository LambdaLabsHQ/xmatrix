import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const CHANNEL = { ...E2E_CHANNEL, messageCount: 2, lastMessageSequence: 2, updatedAt: E2E_NOW };
const XMATRIX = { kind: "system", identityId: "system:xmatrix", userId: "", email: "", label: "xMatrix", name: "xMatrix",
  avatarUrl: "/brand/xmatrix-management-icon.png" };
const TASK = "Check that the agent-router price snapshots are all removed (background: the page's section on price history). "
  + "Count what is left in the table, and delete the cleanup job once nothing is.";
const ONCE = ['let task = "' + TASK + '"', "after(2026-11-17T02:00:00Z)->wait",
  'switch run(@auto(~repo="LambdaLabsHQ/agent-router"), task, ~by=8h)->wait {', "| Answered(report) => Answered(report)",
  '| _ => run(@claude(~repo="LambdaLabsHQ/agent-router"), task, ~by=8h)->wait', "}"].join("\n");
const ask = (holder: string, text: string, extra: Record<string, unknown> = {}) => ({ kind: "ask", verb: "run", holder,
  conditions: { repo: "LambdaLabsHQ/agent-router" }, text, options: [], open: false, by: null, within: 8 * 3_600_000, then: null,
  otherwise: [], ...extra });
const message = (messageId: string, sequence: number, body: string) => ({ messageId, channelId: CHANNEL.id, sequence, sentAt: E2E_NOW,
  from: XMATRIX, body });

test("a program's message draws the program as its flow: what it waits for now, whom it asks what, and what follows each way that can end", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [CHANNEL] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, { hasMore: false, messages: [
    message("norn-page:once", 1, `The program \`check-price-history\` of the page.\n\n\`\`\`norn\n${ONCE}\n\`\`\``),
    // Norn text that is only shown is no program: it stays code.
    message("shown", 2, "A request looks like this:\n\n```norn\nask(@codex, \"shown only\")->wait\n```"),
  ] });
  const day = 86_400_000;
  await fixtureJson(page, "program", "**/api/xmatrix/spaces/*/norn-programs/norn-page%3Aonce", { program: { name: "check-price-history",
    channelId: CHANNEL.id, state: "running", requests: [], next: [
      { kind: "wait", at: new Date(Date.now() + 3 * day + 60_000).toISOString(), on: [], repeats: false, every: null },
      ask("@auto", TASK, { then: "answered", otherwise: [{ when: "otherwise", steps: [
        ask("@claude", TASK, { then: "answered", otherwise: [{ when: "otherwise", steps: [{ kind: "end", failed: true, result: "" }] }] }),
        { kind: "end", failed: false, result: "the answer" }] }] }),
      { kind: "end", failed: false, result: "the answer" }] } });
  await fixtureJson(page, "no-program", "**/api/xmatrix/spaces/*/norn-programs/shown", { program: null });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  const flow = page.getByTestId("message-program-flow").first();
  await expect(flow.locator(".program-flow-step").first()).toHaveAttribute("data-kind", "wait", { timeout: 20_000 });
  // Where it stands now is its first step, with the time that is left.
  await expect(flow.locator(".program-flow-step").first()).toHaveAttribute("data-state", "now");
  await expect(flow.locator(".program-flow-step").first().locator(".program-flow-note")).toHaveText("waiting · 3 d left");
  // What is asked is read in full, where its code is one long line; asked again of someone else it is not repeated.
  const asked = flow.locator(".program-flow-steps").first().locator("> .program-flow-step[data-kind=ask]");
  await expect(asked.locator("> .program-flow-body > .program-flow-head .program-flow-title")).toHaveText("auto");
  await expect(asked.locator("> .program-flow-body > .program-flow-text")).toContainText("delete the cleanup job once nothing is.");
  const branch = asked.locator("> .program-flow-body > .program-flow-branch");
  await expect(branch.locator("> .program-flow-when")).toHaveText("otherwise");
  await expect(branch.locator(".program-flow-title").first()).toHaveText("claude");
  await expect(branch.locator(".program-flow-text").first()).toHaveText("the same request");
  await expect(flow.locator(".program-flow-steps").first().locator("> .program-flow-step").last()).toContainText("Ends with the answer");
  // The flow stands over the program's text; text that is only shown has no flow.
  await expect(page.locator('[id="message:norn-page:once"] .message-code-block')).toContainText("after(2026-11-17T02:00:00Z)");
  await expect(page.locator('[id="message:shown"] .program-flow')).toHaveCount(0);
  await expect(page.locator('[id="message:shown"] .message-code-block')).toContainText("shown only");
  await page.screenshot({ path: test.info().outputPath("norn-program-flow.png") });
});
