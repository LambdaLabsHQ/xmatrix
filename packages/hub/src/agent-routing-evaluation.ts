import { MAX_INPUT_BYTES, type JevInput } from "@xmatrix/decision-model";
import { parseDecisionAnswerFailure, type DecisionAnswerFailure, type DecisionAnswerIssue , utf8ByteLength } from "@xmatrix/protocol";

/** Which storage step failed; a category only, never the underlying message. */
export type DecisionEvidenceStage = "unconfigured" | "oversize" | "intent" | "upload" | "commit"
  | "clock_resolve" | "clock_arm" | "unknown";

/** Thrown by a recordDecision implementation to name the step that failed. */
export class DecisionEvidenceStepFailed extends Error {
  constructor(readonly stage: DecisionEvidenceStage) { super(`Decision evidence ${stage} failed`); }
}

const EVIDENCE_STAGES: readonly string[] = ["unconfigured", "oversize", "intent", "upload", "commit",
  "clock_resolve", "clock_arm"];

/** Structural, so a step failure is recognised across separately loaded module copies. */
function evidenceStageOf(error: unknown): DecisionEvidenceStage {
  const stage = error instanceof Error ? (error as { stage?: unknown }).stage : undefined;
  return typeof stage === "string" && EVIDENCE_STAGES.includes(stage) ? stage as DecisionEvidenceStage : "unknown";
}

export class RoutingEvidenceUnavailable extends Error {
  constructor(readonly phase: "started" | "succeeded" | "failed", readonly stage: DecisionEvidenceStage = "unknown") {
    super("Decision evidence could not be stored");
  }
}

const PROVIDER_FAILURE_CODES = ["jev_aborted", "jev_invalid_input", "jev_customer_verification_required",
  "jev_auth_failed", "jev_permission_denied", "jev_rate_limited", "jev_evaluation_failed"] as const;
export type RoutingEvaluationFailureCode = typeof PROVIDER_FAILURE_CODES[number] | "invalid_answer";

/** Only allowlisted diagnostics cross from the provider into user-visible evidence. */
export class RoutingEvaluationFailed extends Error {
  constructor(readonly reason: "provider_error" | "invalid_answer" | "timeout",
    readonly code: RoutingEvaluationFailureCode, readonly answerFailure?: DecisionAnswerFailure) {
    super(code);
  }
}

class InvalidDecisionAnswer extends Error {
  constructor(readonly issue: DecisionAnswerIssue, readonly questionKey?: string) {
    super("Invalid routing answer");
  }
}

export type RoutingDecisionEvent = { decisionId: string; at: string } & (
  { status: "started"; input: JevInput } |
  { status: "succeeded"; answers: Record<string, RoutingChoice>; model?: string } |
  { status: "failed"; reason: "provider_error" | "invalid_answer" | "timeout";
    code: RoutingEvaluationFailureCode; answerFailure?: DecisionAnswerFailure });
export type RoutingEvaluator = ((input: JevInput, options?: { signal?: AbortSignal }) => Promise<{ answers: unknown; model?: string }>) & {
  recordDecision?: (event: RoutingDecisionEvent) => Promise<void>;
};
export type RoutingChoice = { choice: string; probabilities: Record<string, number> };

function record(value: unknown, issue: DecisionAnswerIssue, questionKey?: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidDecisionAnswer(issue, questionKey);
  return value as Record<string, unknown>;
}

/** The model picks one listed option; that pick is the answer. The SDK has
 *  already checked the reply, so the Hub only makes sure the pick is one it
 *  offered (it indexes by it). Probabilities are kept as given, for display. */
export function validateRoutingChoice(value: unknown, options: string[], questionKey?: string): RoutingChoice {
  const answer = record(value, "answer_missing", questionKey);
  if (typeof answer.choice !== "string") throw new InvalidDecisionAnswer("choice_missing", questionKey);
  if (!options.includes(answer.choice)) throw new InvalidDecisionAnswer("choice_not_offered", questionKey);
  const given = answer.probabilities && typeof answer.probabilities === "object" && !Array.isArray(answer.probabilities)
    ? answer.probabilities as Record<string, unknown> : {};
  const probabilities = Object.fromEntries(options.flatMap(key =>
    typeof given[key] === "number" && Number.isFinite(given[key]) ? [[key, given[key]]] : []));
  return { choice: answer.choice, probabilities: probabilities as Record<string, number> };
}

/** One read-only choice compares the complete authorized candidate set within a deadline.
 * A transient gateway failure may retry the identical finite request once;
 * no allocation, fallback launch or synthetic probability occurs. */
export async function evaluateRoutingChoices(input: JevInput, evaluate: RoutingEvaluator,
  { budgetMs = 10_000 }: { budgetMs?: number } = {}): Promise<Record<string, RoutingChoice>> {
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 10_000) throw new Error("Invalid routing budget");
  // Freeze the serialized request before persistence so later caller mutations
  // cannot make the stored input differ from the model's actual input.
  input = JSON.parse(JSON.stringify(input));
  const questions = Object.entries(input.questions);
  if (!questions.length || questions.length > 8 || questions.some(([, question]) =>
    question.type !== "choice" || !Object.keys(question.criteria).length)) {
    throw new Error("Invalid routing question");
  }
  const assertSize = (request: JevInput) => {
    if (utf8ByteLength(JSON.stringify(request)) > MAX_INPUT_BYTES) {
      throw new Error("Routing input exceeds limit");
    }
  };
  // Reject oversized input before calling the model.
  assertSize(input);
  const persist = async (event: RoutingDecisionEvent) => {
    try { await evaluate.recordDecision?.(event); }
    catch (error) {
      const stage = evidenceStageOf(error);
      console.error(JSON.stringify({ event: "summon_decision_evidence_unavailable",
        decisionId: event.decisionId, phase: event.status, stage }));
      throw new RoutingEvidenceUnavailable(event.status, stage);
    }
  };
  const decisionId = crypto.randomUUID();
  await persist({ decisionId, at: new Date().toISOString(), status: "started", input });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const invoke = async (request: JevInput) => {
    assertSize(request);
    controller.signal.throwIfAborted();
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Routing evaluation interrupted"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([evaluate(request, { signal: controller.signal }), interrupted]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
  };
  let phase: "provider_error" | "invalid_answer" = "provider_error";
  let validated: Record<string, RoutingChoice>;
  let model: string | undefined;
  try {
    let result;
    try { result = await invoke(input); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (controller.signal.aborted || code !== "jev_evaluation_failed" && code !== "jev_rate_limited") throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
      result = await invoke(input);
    }
    phase = "invalid_answer";
    // The model that answered is recorded with the answers, so the launch
    // details can say which model decided each step.
    model = typeof result?.model === "string" && result.model ? result.model : undefined;
    const answers = record(result?.answers, "answers_missing");
    if (Object.keys(answers).some(key => !Object.hasOwn(input.questions, key))) {
      throw new InvalidDecisionAnswer("unexpected_answer");
    }
    // Every question is required. Never return a partially usable launch configuration.
    validated = Object.fromEntries(questions.map(([key, question]) => {
      if (question.type !== "choice") throw new Error("Invalid routing question");
      return [key, validateRoutingChoice(answers[key], Object.keys(question.criteria), key)];
    }));
  } catch (error) {
    const providerCode = error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" && (PROVIDER_FAILURE_CODES as readonly string[]).includes(error.code)
      ? error.code as typeof PROVIDER_FAILURE_CODES[number] : "jev_evaluation_failed";
    const reason = controller.signal.aborted || providerCode === "jev_aborted" && phase === "provider_error"
      ? "timeout" : phase;
    const code = reason === "invalid_answer" ? "invalid_answer"
      : reason === "timeout" ? "jev_aborted" : providerCode;
    const answerFailure = reason === "invalid_answer" && error instanceof InvalidDecisionAnswer
      ? parseDecisionAnswerFailure({ issue: error.issue,
        ...(error.questionKey ? { questionKey: error.questionKey } : {}) }) : undefined;
    await persist({ decisionId, at: new Date().toISOString(), status: "failed", reason, code,
      ...(answerFailure ? { answerFailure } : {}) });
    throw new RoutingEvaluationFailed(reason, code, answerFailure);
  } finally {
    // Cancel any outstanding transport work after completion or failure.
    controller.abort();
    clearTimeout(timer);
  }
  await persist({ decisionId, at: new Date().toISOString(), status: "succeeded", answers: validated,
    ...(model ? { model } : {}) });
  return validated;
}
