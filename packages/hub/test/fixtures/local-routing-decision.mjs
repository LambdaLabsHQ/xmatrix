// Bundled only by the opt-in local reproduction config, never production.
export { MAX_INPUT_BYTES } from "../../../decision-model/src/jev.mjs";
export function createJevClient() {
  return { async evaluate(input) {
    return { answers: Object.fromEntries(Object.entries(input.questions).map(([name, question]) => {
      // A yes/no judgment (message supersession) answers no: the message stays whole.
      if (question.type === "boolean") return [name, { type: "boolean", probability: 0 }];
      const keys = Object.keys(question.criteria);
      const choice = keys[0];
      if (!choice || question.type !== "choice") throw new Error("Unsupported local routing question");
      return [name, { choice, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
    })) };
  } };
}
