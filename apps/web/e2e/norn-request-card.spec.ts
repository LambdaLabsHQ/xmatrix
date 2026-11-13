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
