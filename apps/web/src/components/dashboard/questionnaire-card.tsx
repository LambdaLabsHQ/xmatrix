"use client";

// A question an Agent's harness asks through its own protocol (Claude's
// AskUserQuestion, Codex's request_user_input, an ACP elicitation). The Run
// parks the harness's request and posts it as this card; the answer goes back
// as a reply the Run hands to that request, so the harness continues its turn.

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { ArrowUp, Check, Circle, CircleDot, Pencil, Square, SquareCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionClass } from "@/components/ui/action-tone";
import { ToolDetailSection } from "./tool-split";
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

/** The answers each card in the loaded timeline already got, by card message id. */
const AnsweredQuestionnaires = createContext<ReadonlyMap<string, Record<string, string[]>>>(new Map());

function answersOf(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([id, values]) => [
    id,
    Array.isArray(values) ? values.map(trimmed).filter(Boolean) : [],
  ]));
}

export function AnsweredQuestionnairesProvider({ timeline, children }: { timeline: readonly TimelineItem[]; children: ReactNode }) {
  const answered = useMemo(() => {
    const map = new Map<string, Record<string, string[]>>();
    for (const item of timeline) {
      const metadata = item.metadata;
      if (metadata?.kind !== QUESTIONNAIRE_ANSWER_KIND) continue;
      const cardId = trimmed(metadata.questionnaireMessageId);
      if (cardId && !map.has(cardId)) map.set(cardId, answersOf(metadata.answers));
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
  const recorded = useContext(AnsweredQuestionnaires).get(message.messageId ?? "");
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, string[]> | null>(null);
  // Once answered, the card shows the answer it got and takes no other.
  const answers = recorded ?? sent;

  function answerFor(question: QuestionnaireQuestion): string[] {
    const ids = selected[question.id] ?? [];
    const labels = question.options.filter((option) => ids.includes(option.id)).map((option) => option.label);
    const typed = (other[question.id] ?? "").trim();
    return typed ? [...labels, typed] : labels;
  }

  const canSubmit = !answers && questionnaire.questions.every((question) => answerFor(question).length > 0);

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
    const picked: Record<string, string[]> = {};
    const lines = questionnaire.questions.map((question) => {
      picked[question.id] = answerFor(question);
      const value = picked[question.id].join(", ");
      return questionnaire.questions.length === 1 ? value : `${question.label}: ${value}`;
    });
    setSent(picked);
    // A failed send reopens the card; the channel shows why.
    void onAnswer(message, { body: lines.join("\n"), requestKey: questionnaire.requestKey, answers: picked }).then((posted) => {
      if (!posted) setSent(null);
    });
  }

  const lone = questionnaire.questions.length === 1 ? questionnaire.questions[0] : undefined;
  const title = [`${questionnaire.harness ?? "Agent"} asks`, lone?.header].filter(Boolean).join(" · ");
  return (
    <div className="mt-1 max-w-2xl" data-questionnaire-card={answers ? "answered" : "open"}>
      <ToolDetailSection
        title={title}
        action={answers ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground">
            <Check className="size-3.5" strokeWidth={2.5} />
            Answered
          </span>
        ) : (
          <button type="button" disabled={!canSubmit} onClick={submit} className={actionClass({ variant: "secondary", size: "sm" })}>
            <ArrowUp className="size-3.5" strokeWidth={2.5} />
            Send answer
          </button>
        )}
      >
        <div className="space-y-3">
          {questionnaire.questions.map((question) => (
            <QuestionLines
              key={question.id}
              question={question}
              header={lone ? undefined : question.header}
              group={`${message.messageId || message.id}:${question.id}`}
              picked={selected[question.id] ?? []}
              typed={other[question.id] ?? ""}
              answer={answers ? (answers[question.id] ?? []) : undefined}
              onToggle={(option) => toggle(question, option)}
              onType={(value) => typeOther(question, value)}
            />
          ))}
        </div>
      </ToolDetailSection>
    </div>
  );
}

/** One question: its prompt, then its options as paper lines. */
function QuestionLines({ question, header, group, picked, typed, answer, onToggle, onType }: {
  question: QuestionnaireQuestion;
  header?: string;
  group: string;
  picked: string[];
  typed: string;
  /** What the card was answered with; the lines no longer take input. */
  answer?: string[];
  onToggle: (option: QuestionnaireOption) => void;
  onType: (value: string) => void;
}) {
  const multiple = question.selectionMode === "multiple";
  const Off = multiple ? Square : Circle;
  const On = multiple ? SquareCheck : CircleDot;
  const known = new Set(question.options.map((option) => option.label));
  const typedAnswer = answer?.filter((value) => !known.has(value)).join(", ");
  return (
    <fieldset className="min-w-0" disabled={Boolean(answer)}>
      <legend className="text-[15px] font-bold leading-snug">
        {header ? <span className="mr-1.5 text-xs font-black uppercase tracking-wide text-muted-foreground">{header}</span> : null}
        {question.label}
      </legend>
      <ul className="app-tool-lines mt-1">
        {question.options.map((option) => {
          const chosen = answer ? answer.includes(option.label) : picked.includes(option.id);
          const Mark = chosen ? On : Off;
          return (
            <li key={option.id}>
              <label
                className={cn(
                  "flex w-full min-w-0 items-center gap-3 py-2.5 text-left",
                  answer ? "cursor-default" : "cursor-pointer",
                  answer && !chosen && "opacity-45"
                )}
              >
                <input
                  type={multiple ? "checkbox" : "radio"}
                  name={group}
                  checked={chosen}
                  onChange={() => onToggle(option)}
                  className="sr-only"
                />
                <span className="app-tool-state-icon" data-state={chosen ? "running" : "offline"} aria-hidden="true">
                  <Mark className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate", chosen ? "font-black" : "font-semibold")}>{option.label}</span>
                  {option.description ? (
                    <span className="block truncate text-xs text-muted-foreground">{option.description}</span>
                  ) : null}
                </span>
                {chosen ? <Check className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden="true" /> : null}
              </label>
            </li>
          );
        })}
        {answer ? (
          typedAnswer ? (
            <li>
              <span className="flex w-full min-w-0 items-center gap-3 py-2.5">
                <span className="app-tool-state-icon" data-state="running" aria-hidden="true"><Pencil className="size-4" /></span>
                <span className="min-w-0 flex-1 truncate font-black">{typedAnswer}</span>
                <Check className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden="true" />
              </span>
            </li>
          ) : null
        ) : question.allowOther ? (
          <li>
            <label className="flex w-full min-w-0 items-center gap-3 py-2.5">
              <span className="app-tool-state-icon" data-state={typed.trim() ? "running" : "offline"} aria-hidden="true">
                <Pencil className="size-4" />
              </span>
              <input
                type="text"
                value={typed}
                onChange={(event) => onType(event.target.value)}
                placeholder={question.options.length > 0 ? "Other…" : "Your answer"}
                aria-label={`${question.label}: ${question.options.length > 0 ? "other answer" : "answer"}`}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </label>
          </li>
        ) : null}
      </ul>
    </fieldset>
  );
}
