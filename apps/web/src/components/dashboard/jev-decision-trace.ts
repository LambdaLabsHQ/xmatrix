/**
 * xMatrix routing's retained decision records, read back as what it was asked and what it
 * answered. The Hub stores one record when a reading starts (its whole input)
 * and one when it ends (the answers, or why it failed); both carry the same
 * decision id, so a reading is the pair.
 */

type Json = Record<string, unknown>;

export type JevOption = {
  handle: string;
  /** What the option offers, in a reader's words. */
  title: string;
  detail?: string;
  probability?: number;
  selected: boolean;
};

/** `model`: the routing model that answered this step, when the record names it. */
export type JevQuestion = { key: string; label: string; instructions?: string; model?: string; options: JevOption[] };

export type JevContextMessage = { sentAt?: string; body: string };

export type JevReading = {
  decisionId: string;
  at?: string;
  status: "pending" | "succeeded" | "failed";
  failure?: string;
  /** The mention this reading is about, when Jev read a mention. */
  summon?: string;
  message?: string;
  channel?: string;
  context: JevContextMessage[];
  contextTruncated: boolean;
  questions: JevQuestion[];
  refs: string[];
};

const object = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;

const QUESTION_LABELS: Record<string, string> = {
  harness: "Harness", modelEffort: "Model", workspace: "Location", placement: "Machine",
};

function questionLabel(key: string): string {
  if (key === "intent") return "Request";
  return QUESTION_LABELS[key] ?? key;
}

/** An option's criteria is either a description (intent, placement) or a JSON
 *  object the Hub built from its candidates (harness, model, location). */
function describeOption(handle: string, criteria: unknown): Pick<JevOption, "title" | "detail"> {
  const raw = typeof criteria === "string" ? criteria : JSON.stringify(criteria);
  let parsed: Json | undefined;
  try { parsed = object(JSON.parse(raw)); } catch { parsed = undefined; }
  if (!parsed) {
    const name = handle.replace(/^placement_/u, "");
    return { title: name === "stationary" ? "Stays on" : name === "any" ? "Any, laptops too" : name.charAt(0).toUpperCase() + name.slice(1), detail: raw };
  }
  if (text(parsed.harness)) {
    const models = Array.isArray(parsed.models) ? parsed.models.filter(text) : [];
    const descriptions = Array.isArray(parsed.descriptions) ? parsed.descriptions.filter(text) : [];
    return { title: String(parsed.harness), detail: [...descriptions, models.length ? `models: ${models.join(", ")}` : ""].filter(Boolean).join(" · ") || undefined };
  }
  if ("model" in parsed) {
    const model = parsed.default === true || !text(parsed.model) ? "Harness default" : String(parsed.model);
    const effort = text(parsed.effort);
    return { title: effort ? `${model} · ${effort}` : model,
      detail: [text(parsed.description), effort ? text(parsed.effortDescription) : undefined].filter(Boolean).join(" · ") || undefined };
  }
  const place = text(parsed.repo) ?? text(parsed.canonicalCwd);
  if (place || text(parsed.description)) {
    return { title: place ?? String(parsed.description),
      detail: [place ? text(parsed.description) : undefined, text(parsed.machine)].filter(Boolean).join(" · ") || undefined };
  }
  return { title: handle, detail: raw };
}

/** A fit score: the harness it rates (the JSON its instructions end with)
 *  and its ordered levels, the one nearest the score being the answer. */
function scoreQuestion(key: string, question: Json, levels: unknown[], answer: Json | undefined, model: string | undefined): JevQuestion {
  const instructions = text(question.instructions);
  let rated: Json | undefined;
  try { rated = object(JSON.parse(instructions?.slice(instructions.indexOf("{")) ?? "")); } catch { rated = undefined; }
  const harness = text(rated?.harness);
  const probabilities = object(answer?.probabilities) ?? {};
  const score = typeof answer?.score === "number" && Number.isFinite(answer.score) ? Math.round(answer.score) : undefined;
  const options = levels.map((level, index) => {
    const [title, ...detail] = (text(level) ?? `Level ${index}`).split(": ");
    const probability = probabilities[String(index)];
    return { handle: String(index), title: title!, ...(detail.length ? { detail: detail.join(": ") } : {}), selected: score === index,
      ...(typeof probability === "number" && Number.isFinite(probability) ? { probability } : {}) };
  });
  return { key, label: harness ? `Fit · ${harness}` : "Fit", ...(instructions ? { instructions } : {}), ...(model ? { model } : {}), options };
}

function questionsOf(input: Json | undefined, answers: Json | undefined, model: string | undefined): JevQuestion[] {
  const questions = object(input?.questions) ?? {};
  return Object.entries(questions).flatMap(([key, value]) => {
    const question = object(value);
    if (question?.type === "score" && Array.isArray(question.criteria)) {
      return [scoreQuestion(key, question, question.criteria, object(answers?.[key]), model)];
    }
    const criteria = object(question?.criteria);
    if (!question || !criteria) return [];
    const answer = object(answers?.[key]);
    const probabilities = object(answer?.probabilities) ?? {};
    const options = Object.entries(criteria).map(([handle, offered]) => {
      const probability = probabilities[handle];
      return { handle, ...describeOption(handle, offered), selected: answer?.choice === handle,
        ...(typeof probability === "number" && Number.isFinite(probability) ? { probability } : {}) };
    });
    // The answer first, then the rest by how strongly Jev weighed them.
    options.sort((left, right) => Number(right.selected) - Number(left.selected) ||
      (right.probability ?? -1) - (left.probability ?? -1));
    return [{ key, label: questionLabel(key), instructions: text(question.instructions), ...(model ? { model } : {}), options }];
  });
}

/** Pairs started and finished records by decision id, oldest reading first. */
export function jevReadings(records: Array<{ refId: string; payload: unknown }>): JevReading[] {
  const byDecision = new Map<string, { started?: Json; finished?: Json; refs: string[] }>();
  for (const { refId, payload } of records) {
    const record = object(payload);
    const decisionId = text(record?.decisionId) ?? refId.split(":").slice(1, -1).join(":");
    if (!record || !decisionId) continue;
    const entry = byDecision.get(decisionId) ?? { refs: [] };
    entry.refs.push(refId);
    if (record.status === "started") entry.started = record; else entry.finished = record;
    byDecision.set(decisionId, entry);
  }
  return [...byDecision.entries()].map(([decisionId, { started, finished, refs }]) => {
    const input = object(started?.input);
    const state = object(input?.state);
    const context = object(state?.channelContext);
    const hierarchy = Array.isArray(context?.hierarchy) ? context.hierarchy.map(object) : [];
    const channel = hierarchy.at(-1);
    const messages = Array.isArray(context?.messages) ? context.messages.map(object).flatMap(message =>
      text(message?.body) ? [{ body: String(message!.body), ...(text(message!.sentAt) ? { sentAt: String(message!.sentAt) } : {}) }] : []) : [];
    const status = finished?.status === "succeeded" ? "succeeded" : finished?.status === "failed" ? "failed" : "pending";
    return {
      decisionId, status, refs,
      at: text(started?.at) ?? text(finished?.at),
      ...(status === "failed" ? { failure: [text(finished?.code), text(finished?.reason)].filter(Boolean).join(" · ") || "failed" } : {}),
      summon: text(object(state?.summon)?.text),
      message: text(state?.message) ?? (typeof input?.state === "string" ? input.state : undefined),
      channel: text(channel?.name),
      context: messages,
      contextTruncated: context?.historyTruncated === true,
      questions: questionsOf(input, object(finished?.answers), text(finished?.model)),
    } satisfies JevReading;
  }).sort((left, right) => (Date.parse(left.at ?? "") || 0) - (Date.parse(right.at ?? "") || 0));
}

/** Jev reads one summon in steps (who runs it, then with what and where), each
 *  a call of its own over the same message. Consecutive calls about the same
 *  mention are one decision: its input once, then every answer in order. */
export function jevDecisions(readings: JevReading[]): JevReading[] {
  const decisions: JevReading[] = [];
  for (const reading of readings) {
    const previous = decisions.at(-1);
    if (previous && previous.summon === reading.summon && previous.message === reading.message && !previous.failure) {
      decisions[decisions.length - 1] = { ...previous, status: reading.status, failure: reading.failure,
        context: previous.context.length ? previous.context : reading.context,
        questions: [...previous.questions, ...reading.questions], refs: [...previous.refs, ...reading.refs] };
    } else decisions.push(reading);
  }
  return decisions;
}
