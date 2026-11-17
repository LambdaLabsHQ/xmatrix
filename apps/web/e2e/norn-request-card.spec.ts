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

test("the person asked delegates the request from its card to an Agent here, and takes it back while it is theirs", async ({ page }) => {
  const asked = await openCard(page, card(request()));
  await fixtureJson(page, "delegate", `**/api/xmatrix/channels/${CHANNEL.id}/norn-requests/rabcdefgh23/delegate`,
    { status: "running" }, { method: "POST" });
  await fixtureJson(page, "reclaim", `**/api/xmatrix/channels/${CHANNEL.id}/norn-requests/rabcdefgh23/reclaim`,
    { status: "running" }, { method: "POST" });
  // The Hub says whether it is still open and theirs to take back; the card offers it only then.
  await fixtureJson(page, "request", "**/api/xmatrix/spaces/*/norn-requests/rabcdefgh23", { request: { ref: "rabcdefgh23",
    channelId: CHANNEL.id, holder: "@claude:2", text: "Ship release 4.2 to everyone?", state: "open", reply: null, yoursToTakeBack: true } });
  await asked.getByRole("button", { name: "Delegate…" }).click({ timeout: 20_000 });
  await asked.getByLabel("Who answers it for you").fill("claude:2");
  await asked.getByLabel("Why it is theirs to answer").fill("You read the release notes");
  await page.screenshot({ path: test.info().outputPath("norn-request-delegate.png") });
  await asked.getByRole("button", { name: "Delegate", exact: true }).click();
  await expect(asked).toContainText("Delegated to claude:2: You read the release notes");
  await expect(asked).toHaveAttribute("data-ask-card", "settled");
  await expect.poll(() => fixtureRequestBodies(page, "delegate")).toEqual([{ to: "@claude:2", reason: "You read the release notes" }]);
  await asked.getByRole("button", { name: "Take back" }).click();
  await expect(asked).toContainText("You took it back");
  await expect.poll(() => fixtureRequestBodies(page, "reclaim")).toEqual([{}]);
});

test("a request delegated to the reader says by whom, and declining it gives it back", async ({ page }) => {
  const asked = await openCard(page, card(request({ delegatedBy: "@Daniel" })));
  await expect(asked).toContainText("Daniel delegated this to you: you answer it for them.", { timeout: 20_000 });
  // A delegate answers it or gives it back; passing it on again is not theirs to do.
  await expect(asked.getByRole("button", { name: "Delegate…" })).toHaveCount(0);
  await asked.getByRole("button", { name: "Give back" }).click();
  await expect(asked).toContainText("You gave it back to Daniel: Given back");
  await expect.poll(() => fixtureRequestBodies(page, "answer")).toEqual([{ outcome: "refused", text: "Given back" }]);
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
  const asked = "@claude repo:acme/app\n\n**Request** `request:rabcdefgh23`";
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
  // The task itself is read in full, as the paragraphs it was written in.
  await expect(page.getByTestId("request-reference-block")).toContainText("Keep the whole task here.");
  await expect(page.getByTestId("request-reference-block")).toContainText("waiting for @claude");
  await page.screenshot({ path: test.info().outputPath("norn-agent-request.png") });
});

test("a request's reference in a message reads as the request: what is asked, of whom, how it stands", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [CHANNEL] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, { messages: [{ messageId: "delivery",
    channelId: CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: XMATRIX,
    body: "@codex\n\n**Request** `request:rabcdefgh23` from a program. Your answer goes back to the program." }], hasMore: false });
  await fixtureJson(page, "request", "**/api/xmatrix/spaces/*/norn-requests/rabcdefgh23", { request: { ref: "rabcdefgh23",
    channelId: CHANNEL.id, holder: "@codex", text: "Audit the day's merges\nand the changelog", state: "answered", reply: "nothing to fix" } });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  const chip = page.getByTestId("request-reference-chip");
  await expect(chip).toContainText("Audit the day's merges", { timeout: 20_000 });
  await expect(chip).toHaveAttribute("data-request-state", "answered");
  await expect(page.locator('[id="message:delivery"]')).not.toContainText("rabcdefgh23");
  await page.screenshot({ path: test.info().outputPath("norn-request-reference.png") });
});

test("a long task is read in full as paragraphs, not as a chip or a cut line", async ({ page }) => {
  const first = "按「搜索与候选」做每周供应商池维护。榜单在管理页（独立持久化）：先用 CLI `admin aggregate pool get` 读最新快照与 revision，不从 Page 读逐站名单。"
    + "主任务是逐家复查池内所有站点和待办，未完成覆盖前不优先找新站。".repeat(8);
  const second = "维护完成后再看新站：有空位、或证据不弱且可比条件明确地优于旧项时才入池。最终报告显式发到本轮会话。";
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [CHANNEL] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, { messages: [{ messageId: "delivery",
    channelId: CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: XMATRIX,
    body: "@codex\n\n**Request** `request:rabcdefgh23`" }], hasMore: false });
  await fixtureJson(page, "request", "**/api/xmatrix/spaces/*/norn-requests/rabcdefgh23", { request: { ref: "rabcdefgh23",
    channelId: CHANNEL.id, holder: "@codex", text: `${first}\n\n${second}`, state: "open" } });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  const block = page.getByTestId("request-reference-block");
  await expect(block).toContainText("最终报告显式发到本轮会话。", { timeout: 20_000 });
  await expect(block).toContainText("waiting for @codex");
  const paragraphs = block.locator(".app-request-block-paragraph");
  await expect(paragraphs).toHaveCount(2);
  // Body text on the page's own ground: no capsule behind the words.
  expect(await paragraphs.first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await expect(block.locator("code")).toHaveText("admin aggregate pool get");
  await expect(page.getByTestId("request-reference-chip")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("norn-long-request-paragraphs.png") });
});

test("a question an Agent asked with a command is one card: it names the asker, and neither its program nor its end takes a row", async ({ page }) => {
  const question = "数据库里两张没人用的旧定时表，要删吗？删的话我先改一道安全检查并发版，再请你点一次工作流；不删就留着，对用户没有影响。";
  const asked = request({ verb: "choose", options: ["DropTables", "KeepTables"], about: null, text: question, asker: "claude:2",
    otherwise: "KeepTables" });
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [{ ...CHANNEL, messageCount: 3, lastMessageSequence: 3 }] });
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${CHANNEL.id}/history**`, { hasMore: false, messages: [
    { messageId: "norn-ask:0b5e", channelId: CHANNEL.id, sequence: 1, sentAt: E2E_NOW, from: XMATRIX,
      body: `claude asks E2E Tester:\n\n\`\`\`norn run\ntype choice = DropTables | KeepTables\nswitch choose(@E2E Tester, "${question}", [DropTables, KeepTables], ~by=1d)->wait {\n| NoReply => Answered(KeepTables)\n| other => other\n}\n\`\`\`` },
    { ...card(asked), sequence: 2 },
    { messageId: "norn-end:norn-ask:0b5e", channelId: CHANNEL.id, sequence: 3, sentAt: E2E_NOW, from: XMATRIX,
      body: "@claude:2 The program finished: Answered(DropTables)" }] });
  await fixtureJson(page, "answer", `**/api/xmatrix/channels/${CHANNEL.id}/norn-requests/rabcdefgh23/answer`,
    { status: "running" }, { method: "POST" });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  const shown = page.locator("[data-ask-card]");
  await expect(shown).toContainText(question, { timeout: 20_000 });
  await expect(shown).toContainText("claude:2 asks");
  await expect(shown).toContainText("Without an answer by then: KeepTables.");
  const timeline = page.locator("main");
  await expect(timeline).not.toContainText("type choice");
  await expect(timeline).not.toContainText("The program finished");
  // Nor does the conversation's row preview it: the row shows the card's words.
  await expect(page.getByText(/The program fini/u)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("norn-ask-one-card.png") });
  await shown.getByRole("button", { name: "DropTables" }).click();
  await expect(shown).toContainText("You answered: DropTables");
  await expect(shown).not.toContainText("Without an answer by then");
  await page.screenshot({ path: test.info().outputPath("norn-ask-answered.png") });
});
