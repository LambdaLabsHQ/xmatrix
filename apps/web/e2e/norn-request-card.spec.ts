import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson, fixtureRequestBodies, openWorkspaceWithStubs,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const CHANNEL = { ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1, updatedAt: E2E_NOW };
const XMATRIX = { kind: "system", identityId: "system:xmatrix", userId: "", email: "", label: "xMatrix", name: "xMatrix",
  avatarUrl: "/brand/xmatrix-management-icon.png" };
const request = (extra: Record<string, unknown> = {}) => ({ ref: "rabcdefgh23", verb: "confirm", holder: "@E2E Tester",
  holderUserId: "e2e-user", text: "Ship release 4.2 to everyone?", about: "Release 4.2", context: null, options: [],
  by: "2026-11-20T09:00:00.000Z", ...extra });
const card = (nornRequest: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ messageId: "norn:rabcdefgh23:0",
  channelId: CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: XMATRIX, messageKind: "xmatrix.system.norn-request",
  body: "@E2E Tester Ship release 4.2 to everyone?\n\nAnswer on this card: Yes or No. A program asks.",
  metadata: { nornRequest, xmatrixSystemNotice: true, xmatrixProvenance: "system_fact" }, ...extra });

async function openCard(page: Parameters<typeof openWorkspaceWithStubs>[0], message: ReturnType<typeof card>) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [CHANNEL] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, { messages: [message], hasMore: false });
  await fixtureJson(page, "answer", `**/api/xmatrix/channels/${CHANNEL.id}/norn-requests/rabcdefgh23/answer`,
    { status: "running" }, { method: "POST" });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  return page.locator("[data-ask-card]");
}

test("the person a program asks answers on its card, and the card says what they answered", async ({ page }) => {
  const asked = await openCard(page, card(request()));
  await expect(asked).toContainText("Ship release 4.2 to everyone?", { timeout: 20_000 });
  await expect(asked).toHaveAttribute("data-ask-card", "open");
  await expect(asked).toContainText("A program asks · Release 4.2");
  await expect(asked).toContainText("Without an answer by then it counts as no reply.");
  await page.screenshot({ path: test.info().outputPath("norn-request-open.png") });
  await asked.getByRole("button", { name: "Yes" }).click();
  await expect(asked).toContainText("You answered: Yes");
  await expect(asked).toHaveAttribute("data-ask-card", "settled");
  await expect(asked.getByRole("button", { name: "No" })).toHaveCount(0);
  await expect.poll(() => fixtureRequestBodies(page, "answer")).toEqual([{ outcome: "answered", text: "Yes" }]);
});

test("a request for words says it waits for the reader's answer, and leads with what is asked", async ({ page }) => {
  const asked = await openCard(page, card(request({ verb: "ask", by: null, about: "使用验证",
    text: "使用验证：在常在线服务器建独立 QA profile，准备 Provider 身份 · page:fbfd3bc1-c3db-598f-8030-c2abd7ce3042#使用验证\n\n办完了、定了，或者不办，都在这里写一句；需要 Agent 接着做的也写在这里。" })));
  await expect(asked.getByRole("heading")).toContainText("准备 Provider 身份", { timeout: 20_000 });
  // The question is the first paragraph alone; how to answer reads under it, not in the headline.
  await expect(asked.getByRole("heading")).not.toContainText("写一句");
  await expect(asked).toContainText("都在这里写一句");
  await expect(asked.getByRole("heading")).not.toContainText("page:fbfd3bc1");
  await expect(asked).toContainText("Waiting for your answer");
  await expect(asked.getByPlaceholder("Write your answer here…")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("system fact");
  await page.screenshot({ path: test.info().outputPath("norn-request-words.png") });
});

test("an option that takes words is completed before it is sent, and a request can be declined with a reason", async ({ page }) => {
  const asked = await openCard(page, card(request({ verb: "choose", options: ["Low", "High(say why)"], by: null })));
  await asked.getByRole("button", { name: "High(say why)" }).click({ timeout: 20_000 });
  await expect(asked.getByLabel("Your answer")).toHaveValue("High(say why)");
  await asked.getByLabel("Your answer").fill("High(\"the migration is not rehearsed\")");
  await asked.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "answer"))
    .toEqual([{ outcome: "answered", text: "High(\"the migration is not rehearsed\")" }]);
});

test("everyone else reads whom it waits for, and afterwards how it ended", async ({ page }) => {
  const waiting = await openCard(page, card(request({ holder: "@Daniel", holderUserId: "someone-else" })));
  await expect(waiting).toContainText("Waiting for @Daniel", { timeout: 20_000 });
  await expect(waiting.getByRole("button")).toHaveCount(0);
  const ended = await openCard(page, card(request(), { commandResult: { notes: [{ id: "note", text: "@E2E Tester answered: No", at: E2E_NOW }] } }));
  await expect(ended).toContainText("@E2E Tester answered: No", { timeout: 20_000 });
  await expect(ended.getByRole("button")).toHaveCount(0);
});

test("a request of an Agent reads as the request, without the Agent's copy of the task or how it answers", async ({ page }) => {
  const asked = "@claude repo:acme/app launch:force\n\n**Request** `request:rabcdefgh23`";
  const answering = "\n\n```text\nRecord why the next iOS build needs a device recording.\nKeep the whole task here.\n```\n\n"
    + "The request is from a program. End this turn with exactly one of these:\n\n- `xmatrix reply rabcdefgh23 '<answer>'` when it is done.";
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [CHANNEL] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, { hasMore: false, messages: [
    { messageId: "norn:rabcdefgh23:0", channelId: CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: XMATRIX,
      body: asked + answering, metadata: { nornAnswerFrom: asked.length } },
    // The mark is the Hub's: the same words from anyone else are shown as they wrote them.
    { messageId: "lookalike", channelId: CHANNEL.id, sequence: 2, sentAt: E2E_NOW,
      from: { kind: "user", identityId: "user:someone-else", userId: "someone-else", email: "", label: "Mallory", name: "Mallory" },
      body: "Visible start. Hidden end: xmatrix reply nothing", metadata: { nornAnswerFrom: 14 } }] });
  await fixtureJson(page, "request", "**/api/xmatrix/spaces/*/norn-requests/rabcdefgh23", { request: { ref: "rabcdefgh23",
    channelId: CHANNEL.id, holder: "@claude", text: "Record why the next iOS build needs a device recording.\nKeep the whole task here.", state: "open" } });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  const timeline = page.locator("main");
  await expect(timeline).toContainText("Record why the next iOS build needs a device recording.", { timeout: 20_000 });
  await expect(timeline).toContainText("Hidden end: xmatrix reply nothing");
  await expect(timeline).not.toContainText("xmatrix reply rabcdefgh23");
  await expect(timeline).not.toContainText("from a program");
  await expect(timeline).not.toContainText("Keep the whole task here.");
  await page.screenshot({ path: test.info().outputPath("norn-agent-request.png") });
});

test("a request's reference in a message reads as the request: what is asked, of whom, how it stands", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [CHANNEL] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, { messages: [{ messageId: "delivery",
    channelId: CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: XMATRIX,
    body: "@codex launch:force\n\n**Request** `request:rabcdefgh23` from a program. Your answer goes back to the program." }], hasMore: false });
  await fixtureJson(page, "request", "**/api/xmatrix/spaces/*/norn-requests/rabcdefgh23", { request: { ref: "rabcdefgh23",
    channelId: CHANNEL.id, holder: "@codex", text: "Audit the day's merges\nand the changelog", state: "answered", reply: "nothing to fix" } });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  const chip = page.getByTestId("request-reference-chip");
  await expect(chip).toContainText("Audit the day's merges", { timeout: 20_000 });
  await expect(chip).toHaveAttribute("data-request-state", "answered");
  await expect(page.locator('[id="message:delivery"]')).not.toContainText("rabcdefgh23");
  await page.screenshot({ path: test.info().outputPath("norn-request-reference.png") });
});
