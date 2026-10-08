import { hasControlCharacter } from "./field-validation.js";
/** One Jev answer: the exact input it read and the distribution it returned. */
export interface LaunchDecisionStage { inputDigest: string; selected: string; probabilities: Record<string, number> }

/** Public decision evidence contains opaque workspace handles, never private directory catalogs. */
export interface LaunchParameterEvidence {
  rubricVersion: string;
  evaluatedAt: string;
  inputDigest: string;
  /** Which harness Jev read as suited to the work, keyed by harness. The
   * machine is then chosen by measured headroom, not by Jev. */
  harness?: LaunchDecisionStage;
  /** Before `registration-parameters-v6`: Jev's choice among whole environments. */
  environment?: LaunchDecisionStage;
  /** How the launch mention was read as a request: Jev's answer, or the author's `launch:force`. */
  intent?: { source: "jev"; selected: "summon"; probabilities: Record<string, number> } | { source: "author" };
  /** `repo` names the chosen repository; a directory is never named. */
  selections: { model?: string; effort?: string; workspaceKind: "repo" | "local-path" | "managed"; repo?: string };
  /** `placement` is a `registration-parameters-v7` choice about the work.
   * `registration-parameters-v8` does not ask it: a laptop is the machine's own
   * reported form, not a Jev option. Older records may still carry the choice.
   * `registration-parameters-v9` omits modelEffort and selections.model when
   * no models are declared, leaving the runtime's defaults untouched. */
  choices: Array<{ key: "modelEffort" | "workspace" | "placement";
    selected: string; probabilities: Record<string, number> }>;
}

/** The Hub accepts a distribution the routing model rounded to two decimals:
 *  each probability may be off by half a hundredth, so its sum by that per option. */
const ROUNDED_PROBABILITY_ERROR = .005 + 1e-9;

/** A distribution over handles matching `handle` that sums to one, in which
 * `selected` is listed and the most probable. */
function distribution(value: unknown, handle: RegExp, selected: unknown, limit = 100): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof selected !== "string") return undefined;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > limit || !entries.some(([key]) => key === selected) ||
      entries.some(([key, probability]) => !handle.test(key) || typeof probability !== "number" ||
        !Number.isFinite(probability) || probability < 0 || probability > 1) ||
      Math.abs(entries.reduce((sum, [, probability]) => sum + Number(probability), 0) - 1) >
        Math.max(.02, entries.length * ROUNDED_PROBABILITY_ERROR) ||
      Number((value as Record<string, number>)[selected]) !== Math.max(...entries.map(([, p]) => Number(p)))) return undefined;
  return Object.fromEntries(entries) as Record<string, number>;
}

/** A stage is absent, or present and consistent; `null` means present but invalid. */
function stage(value: unknown, handle: RegExp): LaunchDecisionStage | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { inputDigest, selected, probabilities } = value as Record<string, unknown>;
  const parsed = typeof inputDigest === "string" && /^[a-f0-9]{64}$/u.test(inputDigest)
    ? distribution(probabilities, handle, selected) : undefined;
  return parsed ? { inputDigest: inputDigest as string, selected: selected as string, probabilities: parsed } : null;
}

/** Every recorded decision must be present and internally consistent to be displayed. */
export function parseLaunchParameterEvidence(value: unknown): LaunchParameterEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const text = (value: unknown, limit: number): value is string => typeof value === "string" &&
    value.length > 0 && value.length <= limit && !hasControlCharacter(value);
  if (!text(row.rubricVersion, 80) || !text(row.evaluatedAt, 40) || !Number.isFinite(Date.parse(row.evaluatedAt)) ||
      !text(row.inputDigest, 128) || !/^[a-f0-9]{64}$/u.test(row.inputDigest) ||
      !row.selections || typeof row.selections !== "object" || Array.isArray(row.selections) ||
      !Array.isArray(row.choices) || row.choices.length < 1 || row.choices.length > 3) return undefined;
  const selected = row.selections as Record<string, unknown>;
  const skipsModel = row.rubricVersion === "registration-parameters-v9" && selected.model === undefined;
  if ((!skipsModel && !text(selected.model, 160)) || skipsModel && selected.effort !== undefined ||
      selected.effort !== undefined && !text(selected.effort, 80) ||
      !["repo", "local-path", "managed"].includes(String(selected.workspaceKind)) ||
      selected.repo !== undefined && (selected.workspaceKind !== "repo" || !text(selected.repo, 300))) return undefined;
  const choices: LaunchParameterEvidence["choices"] = [];
  for (const raw of row.choices) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const { key, selected: choice, probabilities } = raw as Record<string, unknown>;
    if (!["modelEffort", "workspace", "placement"].includes(String(key)) || choices.some(item => item.key === key)) return undefined;
    const parsed = distribution(probabilities, key === "modelEffort" ? /^model_\d{1,3}$/u
      : key === "workspace" ? /^workspace_\d{1,3}$/u : /^placement_(?:any|stationary)$/u, choice);
    if (!parsed) return undefined;
    choices.push({ key: key as LaunchParameterEvidence["choices"][number]["key"], selected: choice as string, probabilities: parsed });
  }
  if (choices.some(item => item.key === "modelEffort") === skipsModel || !choices.some(item => item.key === "workspace")) return undefined;
  const harness = stage(row.harness, /^[a-z0-9][a-z0-9._-]{0,63}$/u);
  const environment = stage(row.environment, /^candidate_\d{1,3}$/u);
  if (harness === null || environment === null) return undefined;
  let intent: LaunchParameterEvidence["intent"];
  if (row.intent !== undefined) {
    if (!row.intent || typeof row.intent !== "object" || Array.isArray(row.intent)) return undefined;
    const reading = row.intent as Record<string, unknown>;
    if (reading.source === "author") intent = { source: "author" };
    else {
      const probabilities = reading.source === "jev" && reading.selected === "summon"
        ? distribution(reading.probabilities, /^[a-z]{1,20}$/u, "summon", 8) : undefined;
      if (!probabilities) return undefined;
      intent = { source: "jev", selected: "summon", probabilities };
    }
  }
  return { rubricVersion: row.rubricVersion, evaluatedAt: row.evaluatedAt, inputDigest: row.inputDigest,
    ...(harness ? { harness } : {}), ...(environment ? { environment } : {}), ...(intent ? { intent } : {}),
    selections: { ...(!skipsModel ? { model: selected.model as string } : {}), ...(selected.effort ? { effort: selected.effort as string } : {}),
      workspaceKind: selected.workspaceKind as "repo" | "local-path" | "managed",
      ...(selected.repo ? { repo: selected.repo as string } : {}) }, choices };
}
