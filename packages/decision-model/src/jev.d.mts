import type { Experimental_EvaluationQuestion, Experimental_EvaluationResult, JSONValue } from "ai";

export const JEV_MODEL: "typesafe-ai/jev";
export const MAX_INPUT_BYTES: number;
export interface JevInput {
  state: string | Record<string, JSONValue> | JSONValue[];
  questions: Record<string, Experimental_EvaluationQuestion>;
}
export function createJevClient(options: {
  apiKey?: string;
  timeoutMs?: number;
  zeroDataRetention?: boolean;
  fetch?: typeof globalThis.fetch;
}): {
  evaluate(input: JevInput, options?: { signal?: AbortSignal }): Promise<{
    model: typeof JEV_MODEL;
    answers: Experimental_EvaluationResult<JevInput["questions"]>["answers"];
    usage: Experimental_EvaluationResult<JevInput["questions"]>["usage"];
  }>;
};
