import { hasControlCharacter } from "./field-validation.js";
/** One Jev answer: the exact input it read and the distribution it returned. */
export interface LaunchDecisionStage { inputDigest: string; selected: string; probabilities: Record<string, number> }

/** Jev's reading of how well one harness suits the work: a score from 0
 * (unsuitable) to 3 (asked for), and its distribution over those levels. */
export interface LaunchHarnessFit { score: number; probabilities: Record<string, number> }

/** One environment as the joint selection weighed it. `fit` and `headroom`
 * are on 0..1 (headroom below 0 when overloaded, absent when unmeasured). */
export interface LaunchPlacementCandidate {
  harness: string; machineId: string; machineName?: string;
  fit: number; headroom?: number; frontier: boolean; utility: number;
}

/** Public decision evidence contains opaque workspace handles, never private directory catalogs. */
export interface LaunchParameterEvidence {
  rubricVersion: string;
  evaluatedAt: string;
  inputDigest: string;
  /** Which harness Jev read as suited to the work, keyed by harness. The
   * machine is then chosen by measured headroom, not by Jev. */
  harness?: LaunchDecisionStage;
  /** From `registration-parameters-v10`: each harness's fit, asked one
   * harness per question, keyed by harness. */
  fit?: { inputDigest: string; scores: Record<string, LaunchHarnessFit> };
  /** From `registration-parameters-v10`: the best-ranked environments of the
   * joint choice over fit and headroom, the selected one first. */
  placement?: { profile: "balanced"; ranking: LaunchPlacementCandidate[] };
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

/** The model's probabilities as recorded, over handles matching `handle`.
 * They are shown, never judged: the pick is `selected`, whatever they say. */
function distribution(value: unknown, handle: RegExp, selected: unknown, limit = 100): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof selected !== "string" || !handle.test(selected)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > limit || entries.some(([key, probability]) => !handle.test(key) ||
    typeof probability !== "number" || !Number.isFinite(probability))) return undefined;
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

const HARNESS = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const unit = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
const plainRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function parseFit(value: unknown): LaunchParameterEvidence["fit"] | undefined | null {
  if (value === undefined) return undefined;
  if (!plainRecord(value) || typeof value.inputDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.inputDigest) ||
    !plainRecord(value.scores)) return null;
  const entries = Object.entries(value.scores);
  if (!entries.length || entries.length > 100) return null;
  const scores: Record<string, LaunchHarnessFit> = {};
  for (const [harness, reading] of entries) {
    if (!HARNESS.test(harness) || !plainRecord(reading) || !unit(reading.score, 0, 3) || !plainRecord(reading.probabilities)) return null;
    const levels = Object.entries(reading.probabilities);
    if (levels.some(([level, probability]) => !/^[0-3]$/u.test(level) || !unit(probability, 0, 1))) return null;
    scores[harness] = { score: reading.score, probabilities: Object.fromEntries(levels) as Record<string, number> };
  }
  return { inputDigest: value.inputDigest, scores };
}

function parsePlacement(value: unknown): LaunchParameterEvidence["placement"] | undefined | null {
  if (value === undefined) return undefined;
  if (!plainRecord(value) || value.profile !== "balanced" || !Array.isArray(value.ranking) ||
    !value.ranking.length || value.ranking.length > 8) return null;
  const ranking: LaunchPlacementCandidate[] = [];
  for (const item of value.ranking) {
    if (!plainRecord(item) || typeof item.harness !== "string" || !HARNESS.test(item.harness) ||
      typeof item.machineId !== "string" || !item.machineId || item.machineId.length > 128 || hasControlCharacter(item.machineId) ||
      item.machineName !== undefined && (typeof item.machineName !== "string" || !item.machineName ||
        item.machineName.length > 200 || hasControlCharacter(item.machineName)) ||
      !unit(item.fit, 0, 1) || item.headroom !== undefined && !unit(item.headroom, -1_000, 1) ||
      typeof item.frontier !== "boolean" || !unit(item.utility, -1_000, 2)) return null;
    ranking.push({ harness: item.harness, machineId: item.machineId,
      ...(item.machineName !== undefined ? { machineName: item.machineName as string } : {}),
      fit: item.fit, ...(item.headroom !== undefined ? { headroom: item.headroom as number } : {}),
      frontier: item.frontier, utility: item.utility });
  }
  return { profile: "balanced", ranking };
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
  const skipsModel = ["registration-parameters-v9", "registration-parameters-v10"].includes(row.rubricVersion) &&
    selected.model === undefined;
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
  const harness = stage(row.harness, HARNESS);
  const environment = stage(row.environment, /^candidate_\d{1,3}$/u);
  if (harness === null || environment === null) return undefined;
  const fit = parseFit(row.fit), placement = parsePlacement(row.placement);
  if (fit === null || placement === null) return undefined;
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
    ...(harness ? { harness } : {}), ...(fit ? { fit } : {}), ...(placement ? { placement } : {}),
    ...(environment ? { environment } : {}), ...(intent ? { intent } : {}),
    selections: { ...(!skipsModel ? { model: selected.model as string } : {}), ...(selected.effort ? { effort: selected.effort as string } : {}),
      workspaceKind: selected.workspaceKind as "repo" | "local-path" | "managed",
      ...(selected.repo ? { repo: selected.repo as string } : {}) }, choices };
}
