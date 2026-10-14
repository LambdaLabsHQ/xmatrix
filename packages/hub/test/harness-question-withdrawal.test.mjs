import assert from "node:assert/strict";
import { test } from "node:test";

import { channelInstanceSession, recordingAgentInstancePort } from "./support/agent-instance-port.mjs";
import { questionnaireAnswerTarget, settledQuestionnaireRefusal } from "../src/questionnaire-answer.ts";
import { questionnaireStateOf } from "@xmatrix/protocol";

/**
 * A harness withdraws a question it asked on a card (the person answered in
 * the Channel instead, or its turn ended). The host reports only that fact;
 * the Hub settles the card, which ends its wait, and says so in the Channel,
 * so a later answer is refused with the reason rather than becoming a task.
 */
const session = channelInstanceSession();
const withdrawal = { type: "harness_question_closed", requestId: "report-1", channelId: "channel", cardRequestId: "card-1" };

test("a withdrawal settles only the asking Instance's card and says so once", async () => {
  const { port, commands } = recordingAgentInstancePort({
    settleQuestionnaire: async () => ({ state: { state: "cancelled" }, changed: true }),
  });
  const receipt = await port.execute(session, withdrawal);
  assert.equal(receipt.type, "pong");
  assert.equal(receipt.requestId, "report-1", "the host keeps the report until Hub answers it");
  const [settle, notice] = commands;
  assert.equal(settle.family, "settle-questionnaire");
  assert.deepEqual(settle.input, { channelId: "channel", messageId: "message:card-1",
    settlement: { state: "cancelled" }, askedByInstanceId: "instance-1" });
  assert.equal(notice.family, "append-message");
  assert.equal(notice.input.messageKind, "xmatrix.questionnaire.withdrawn", "a Hub fact, not the owner's speech");
  assert.equal(notice.input.residual.replyToMessageId, "message:card-1");
  assert.deepEqual(notice.input.residual.appMetadata.xmatrixQuestionnaireState, { messageId: "message:card-1", state: "cancelled" });
  assert.match(notice.input.body, /^codex withdrew this question/u);
});

test("a card already settled, or not this Instance's, gets no second notice", async () => {
  for (const settled of [{ state: { state: "answered" }, changed: false }, null]) {
    const { port, commands } = recordingAgentInstancePort({ settleQuestionnaire: async () => settled });
    assert.equal((await port.execute(session, withdrawal)).type, "pong");
    assert.deepEqual(commands.map((command) => command.family), ["settle-questionnaire"]);
  }
});

test("a malformed or read-only withdrawal is refused", async () => {
  const { port } = recordingAgentInstancePort({ settleQuestionnaire: async () => null });
  await assert.rejects(port.execute(session, { ...withdrawal, cardRequestId: "bad id" }));
  await assert.rejects(port.execute({ ...session, principal: { ...session.principal, channelWriteAllowed: false } }, withdrawal));
});

test("an answer names its card, and a settled card refuses it with the reason", () => {
  assert.deepEqual(questionnaireAnswerTarget({ kind: "xmatrix.questionnaire_answer.v1", questionnaireMessageId: " card ",
    answers: { branch: ["main", 3] } }), { cardMessageId: "card", answers: { branch: ["main"] } });
  assert.equal(questionnaireAnswerTarget({ kind: "other", questionnaireMessageId: "card" }), undefined);
  assert.equal(settledQuestionnaireRefusal({ state: "cancelled" }).code, "questionnaire_withdrawn");
  assert.match(settledQuestionnaireRefusal({ state: "cancelled" }).error, /Send it as a new message/u);
  assert.equal(settledQuestionnaireRefusal({ state: "answered" }).code, "questionnaire_answered");
});

test("only the Hub's own annotation settles a card", () => {
  const hub = { namespace: "xmatrix.questionnaire", authorUserId: "system:xmatrix", payload: { state: "cancelled" } };
  assert.deepEqual(questionnaireStateOf([hub]), { state: "cancelled" });
  assert.equal(questionnaireStateOf([{ ...hub, authorUserId: "user:mallory" }]), undefined);
  assert.equal(questionnaireStateOf([{ ...hub, payload: { state: "open" } }]), undefined);
  assert.deepEqual(questionnaireStateOf([{ ...hub, payload: { state: "answered", answers: { q: ["a", 1] } } }]),
    { state: "answered", answers: { q: ["a"] } });
});
