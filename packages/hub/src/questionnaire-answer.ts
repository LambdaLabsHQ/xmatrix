import type { QuestionnaireState } from "@xmatrix/protocol";

/** The reply a person sends from a questionnaire card (questionnaire-card.tsx). */
export const QUESTIONNAIRE_ANSWER_KIND = "xmatrix.questionnaire_answer.v1";

/** The card an answer names and what it picked, when the message is a card answer. */
export function questionnaireAnswerTarget(metadata: unknown):
  { cardMessageId: string; answers: Record<string, string[]> } | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = metadata as Record<string, unknown>;
  if (value.kind !== QUESTIONNAIRE_ANSWER_KIND) return undefined;
  const cardMessageId = typeof value.questionnaireMessageId === "string" ? value.questionnaireMessageId.trim() : "";
  if (!cardMessageId) return undefined;
  const raw = value.answers && typeof value.answers === "object" && !Array.isArray(value.answers)
    ? value.answers as Record<string, unknown> : {};
  const answers = Object.fromEntries(Object.entries(raw).slice(0, 50).map(([id, values]) => [
    id.slice(0, 160),
    Array.isArray(values)
      ? values.filter((entry): entry is string => typeof entry === "string").slice(0, 100).map((entry) => entry.slice(0, 2_000))
      : [],
  ]));
  return { cardMessageId, answers };
}

/** Why an answer to a settled card is refused instead of becoming a new task. */
export function settledQuestionnaireRefusal(state: QuestionnaireState): { error: string; code: string } {
  return state.state === "cancelled"
    ? { error: "This question was withdrawn: the agent is no longer waiting for an answer here. Send it as a new message instead.",
        code: "questionnaire_withdrawn" }
    : { error: "This question was already answered.", code: "questionnaire_answered" };
}
