"use client";

// A question an Agent's harness asks through its own protocol (Claude's
// AskUserQuestion, Codex's request_user_input, an ACP elicitation). The Run
// parks the harness's request and posts it as this card; the answer goes back
// as a reply the Run hands to that request, so the harness continues its turn.

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { ArrowUp, Check, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionClass } from "@/components/ui/action-tone";
import { COUNT_CHIP_MATERIAL_CLASS } from "./workspace-shell-constants";
import type { TimelineItem } from "./workspace-shell-message-model";

const QUESTIONNAIRE_KIND = "xmatrix.questionnaire.v1";
const QUESTIONNAIRE_ANSWER_KIND = "xmatrix.questionnaire_answer.v1";

type QuestionnaireOption = {
  id: string;
  label: string;
  description?: string;
};

type QuestionnaireQuestion = {
  id: string;
  label: string;
  header?: string;
  selectionMode: "single" | "multiple";
  allowOther: boolean;
  options: QuestionnaireOption[];
};

type QuestionnaireMetadata = {
  kind: typeof QUESTIONNAIRE_KIND;
  harness?: string;
  requestKey?: string;
  questions: QuestionnaireQuestion[];
};

/** What a person sends from a card: readable text and, per question id, the
 * labels they picked or the text they typed. */
export type QuestionnaireAnswer = {
  body: string;
  requestKey?: string;
  answers: Record<string, string[]>;
};

export function questionnaireAnswerPayload(message: TimelineItem, answer: QuestionnaireAnswer) {
  return {
    body: answer.body,
    replyToMessageId: message.messageId,
    metadata: {
      kind: QUESTIONNAIRE_ANSWER_KIND,
      questionnaireMessageId: message.messageId,
      ...(answer.requestKey ? { requestKey: answer.requestKey } : {}),
      answers: answer.answers,
    },
  };
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function questionnaireMetadata(metadata: Record<string, unknown> | undefined): QuestionnaireMetadata | null {
  if (!metadata || metadata.kind !== QUESTIONNAIRE_KIND) return null;
  const rawQuestions = Array.isArray(metadata.questions) ? metadata.questions : [];
  const questions = rawQuestions.flatMap((item, index): QuestionnaireQuestion[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const label = trimmed(record.label);
    if (!label) return [];
    const options = (Array.isArray(record.options) ? record.options : []).flatMap(
      (option, optionIndex): QuestionnaireOption[] => {
        if (!option || typeof option !== "object") return [];
        const optionRecord = option as Record<string, unknown>;
        const optionLabel = trimmed(optionRecord.label);
        if (!optionLabel) return [];
        return [{
          id: trimmed(optionRecord.id) || `o${optionIndex + 1}`,
          label: optionLabel,
          description: trimmed(optionRecord.description) || undefined,
        }];
      }
    );
    return [{
      id: trimmed(record.id) || `q${index + 1}`,
      label,
      header: trimmed(record.header) || undefined,
      selectionMode: record.selectionMode === "multiple" ? "multiple" : "single",
      // A card from before `allowOther` existed only offered its options,
      // unless it had none.
      allowOther: record.allowOther === true || options.length === 0,
      options,
    }];
  });
  if (questions.length === 0) return null;
  return {
    kind: QUESTIONNAIRE_KIND,
    harness: trimmed(metadata.harness) || undefined,
    // Claude cards from before `requestKey` named their tool use instead.
    requestKey: trimmed(metadata.requestKey) || trimmed(metadata.toolUseId) || undefined,
    questions,
  };
}

/** The answer each card in the loaded timeline already got, by card message id. */
const AnsweredQuestionnaires = createContext<ReadonlyMap<string, string>>(new Map());

export function AnsweredQuestionnairesProvider({ timeline, children }: { timeline: readonly TimelineItem[]; children: ReactNode }) {
  const answered = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of timeline) {
      const metadata = item.metadata;
      if (metadata?.kind !== QUESTIONNAIRE_ANSWER_KIND) continue;
      const cardId = trimmed(metadata.questionnaireMessageId);
      if (cardId && !map.has(cardId)) map.set(cardId, item.body);
    }
    return map;
  }, [timeline]);
  return <AnsweredQuestionnaires.Provider value={answered}>{children}</AnsweredQuestionnaires.Provider>;
}

export function QuestionnaireMessage({
  questionnaire,
  message,
  onAnswer,
}: {
  questionnaire: QuestionnaireMetadata;
  message: TimelineItem;
  onAnswer: (message: TimelineItem, answer: QuestionnaireAnswer) => Promise<boolean>;
}) {
  const answeredBody = useContext(AnsweredQuestionnaires).get(message.messageId ?? "");
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const answered = sent || answeredBody !== undefined;

  function answerFor(question: QuestionnaireQuestion): string[] {
    const ids = selected[question.id] ?? [];
    const labels = question.options.filter((option) => ids.includes(option.id)).map((option) => option.label);
    const typed = (other[question.id] ?? "").trim();
    return typed ? [...labels, typed] : labels;
  }

  const canSubmit = !answered && questionnaire.questions.every((question) => answerFor(question).length > 0);

  function toggle(question: QuestionnaireQuestion, option: QuestionnaireOption) {
    setSelected((current) => {
      const values = current[question.id] ?? [];
      if (question.selectionMode === "multiple") {
        return {
          ...current,
          [question.id]: values.includes(option.id) ? values.filter((value) => value !== option.id) : [...values, option.id],
        };
      }
      return { ...current, [question.id]: [option.id] };
    });
    // One answer per single-choice question: picking an option drops typed text.
    if (question.selectionMode === "single") setOther((current) => ({ ...current, [question.id]: "" }));
  }

  function typeOther(question: QuestionnaireQuestion, value: string) {
    setOther((current) => ({ ...current, [question.id]: value }));
    if (question.selectionMode === "single" && value.trim()) setSelected((current) => ({ ...current, [question.id]: [] }));
  }

  function submit() {
    const answers: Record<string, string[]> = {};
    const lines = questionnaire.questions.map((question) => {
      answers[question.id] = answerFor(question);
      const value = answers[question.id].join(", ");
      return questionnaire.questions.length === 1 ? value : `${question.label}: ${value}`;
    });
    setSent(true);
    // A failed send reopens the card; the channel shows why.
    void onAnswer(message, { body: lines.join("\n"), requestKey: questionnaire.requestKey, answers }).then((posted) => {
      if (!posted) setSent(false);
    });
  }

  const multiple = questionnaire.questions.some((question) => question.selectionMode === "multiple");
  return (
    <div className="mt-2 max-w-3xl border border-border bg-background p-3" data-questionnaire-card={answered ? "answered" : "open"}>
      <div className="mb-2 flex items-center gap-2 text-sm font-black">
        <HelpCircle className="size-4 text-primary" />
        <span>{questionnaire.harness ? `${questionnaire.harness} asks` : "Question"}</span>
        <span className={cn("px-1.5 py-0.5 text-[11px] font-bold uppercase text-muted-foreground", COUNT_CHIP_MATERIAL_CLASS)}>
          {multiple ? "multi" : "single"}
        </span>
      </div>
      <div className="space-y-3">
        {questionnaire.questions.map((question) => (
          <fieldset key={question.id} className="min-w-0" disabled={answered}>
            {question.header && question.header !== question.label ? (
              <div className="text-[11px] font-bold uppercase text-muted-foreground">{question.header}</div>
            ) : null}
            <legend className="mb-1 text-sm font-bold">{question.label}</legend>
            {question.options.length > 0 ? (
              <div className="grid gap-1.5">
                {question.options.map((option) => {
                  const checked = (selected[question.id] ?? []).includes(option.id);
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        "flex min-w-0 cursor-pointer items-start gap-2 border border-border px-2.5 py-2 text-sm transition hover:bg-muted/60",
                        checked && "border-primary bg-primary/10",
                        answered && "cursor-default hover:bg-transparent"
                      )}
                    >
                      <input
                        type={question.selectionMode === "multiple" ? "checkbox" : "radio"}
                        name={`${message.messageId || message.id}:${question.id}`}
                        checked={checked}
                        onChange={() => toggle(question, option)}
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                      />
                      <span className="min-w-0">
                        <span className="block break-words font-bold">{option.label}</span>
                        {option.description && (
                          <span className="mt-0.5 block break-words text-xs text-muted-foreground">{option.description}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}
            {question.allowOther ? (
              <input
                type="text"
                value={other[question.id] ?? ""}
                onChange={(event) => typeOther(question, event.target.value)}
                placeholder={question.options.length > 0 ? "Other…" : "Your answer"}
                aria-label={`${question.label}: ${question.options.length > 0 ? "other answer" : "answer"}`}
                className="mt-1.5 h-8 w-full min-w-0 border border-border bg-background px-2.5 text-sm outline-none focus:border-primary"
              />
            ) : null}
          </fieldset>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {answered ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-bold text-muted-foreground">
            <Check className="size-3.5 shrink-0" strokeWidth={2.5} />
            <span className="truncate">{answeredBody ? `Answered: ${answeredBody}` : "Answered"}</span>
          </span>
        ) : (
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className={actionClass({ variant: "primary", size: "sm" })}
          >
            <ArrowUp className="size-3.5" strokeWidth={2.5} />
            Send answer
          </button>
        )}
      </div>
    </div>
  );
}
