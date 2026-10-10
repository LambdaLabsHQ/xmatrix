import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_NOW,
  E2E_SPACE,
  fixtureJson,
  fixtureRequestBodies,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

const codexSender = {
  identityId: "agent:codex",
  kind: "agent",
  label: "Codex",
  userId: "agent-owner",
  email: "codex@xmatrix.test",
  agentName: "Codex",
};

// As the Run posts Codex's own request_user_input.
const questionCard = {
  messageId: "message-question",
  channelId: "channel-general",
  sequence: 1,
  body: "Codex asks: Which branch should I merge?\n1. main\n2. release",
  sentAt: E2E_NOW,
  from: codexSender,
  metadata: {
    kind: "xmatrix.questionnaire.v1",
    source: "codex",
    harness: "Codex",
    requestKey: "call_merge",
    selectionMode: "single",
    questions: [{
      id: "branch",
      label: "Which branch should I merge?",
      header: "Branch",
      selectionMode: "single",
      allowOther: true,
      options: [
        { id: "o1", label: "main", description: "The default branch." },
        { id: "o2", label: "release", description: "The release branch." },
      ],
    }],
  },
};

async function openChannel(page: import("@playwright/test").Page, messages: unknown[]) {
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [{ ...E2E_CHANNEL, messageCount: messages.length, lastMessageSequence: messages.length, updatedAt: E2E_NOW }],
  });
  await fixtureJson(page, "history", "**/api/xmatrix/channels/channel-general/history**", { messages, hasMore: false });
  await fixtureJson(page, "answer", "**/api/xmatrix/channels/channel-general/messages",
    { message: { id: "answer-id" } }, { method: "POST" });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
}

test("a harness question card answers its request with the picked option", async ({ page }) => {
  await openChannel(page, [questionCard]);
  const card = page.locator('[data-questionnaire-card="open"]');
  await expect(card.getByText("Codex asks · Branch")).toBeVisible();
  await expect(card.getByRole("heading", { name: "Which branch should I merge?" })).toBeVisible();
  const send = card.getByRole("button", { name: "Send answer" });
  await expect(send).toBeDisabled();

  await card.getByText("release", { exact: true }).click();
  await send.click();

  await expect.poll(async () => (await fixtureRequestBodies(page, "answer")).length).toBe(1);
  expect((await fixtureRequestBodies(page, "answer"))[0]).toEqual({
    body: "release",
    replyToMessageId: "message-question",
    metadata: {
      kind: "xmatrix.questionnaire_answer.v1",
      questionnaireMessageId: "message-question",
      requestKey: "call_merge",
      answers: { branch: ["release"] },
    },
  });
  await expect(page.locator('[data-questionnaire-card="answered"]')).toBeVisible();
});

test("an answered card stays closed and shows its answer", async ({ page }) => {
  await openChannel(page, [questionCard, {
    messageId: "message-answer",
    channelId: "channel-general",
    sequence: 2,
    body: "staging",
    sentAt: E2E_NOW,
    replyToMessageId: "message-question",
    from: { identityId: "user:owner", kind: "user", label: "Owner", userId: "owner", email: "owner@xmatrix.test" },
    metadata: {
      kind: "xmatrix.questionnaire_answer.v1",
      questionnaireMessageId: "message-question",
      requestKey: "call_merge",
      answers: { branch: ["staging"] },
    },
  }]);
  const card = page.locator('[data-questionnaire-card="answered"]');
  // The typed answer shows as the chosen line; the options stay, unpicked.
  await expect(card.getByText("staging", { exact: true })).toBeVisible();
  await expect(card.getByRole("radio", { name: /release/ })).not.toBeChecked();
  await expect(card.getByRole("button", { name: "Send answer" })).toHaveCount(0);
  await expect(card.getByRole("textbox")).toHaveCount(0);
});
