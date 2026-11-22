import {
  isAutoHandoffSuccessor,
  isHandoffSuccessorName,
  launchHarnessParameters,
  type AgentRegistrationSummary,
  type AutoLaunchTags,
} from "@xmatrix/protocol";
import { autoLaunchCandidates } from "./auto-launch-completion";

export type HandoffPickerOption = {
  value: string;
  label: string;
  unavailable?: string;
};

export type HandoffPickerParameterGroup = {
  id: string;
  label: string;
  options: HandoffPickerOption[];
};

export type HandoffPickerParameters = {
  machines: HandoffPickerOption[];
  models: HandoffPickerOption[];
  efforts: HandoffPickerOption[];
  parameters: HandoffPickerParameterGroup[];
};

export type HandoffTagChip = {
  key: string;
  field: "machine" | "model" | "effort" | "parameter";
  parameterId?: string;
  label: string;
};

/** Options for each parameter field in the work-dock handoff picker, derived
 *  from the same Space registration catalog as composer completion. */
export function handoffPickerParameters(
  registrations: readonly AgentRegistrationSummary[] = [],
  selected: AutoLaunchTags = {},
): HandoffPickerParameters {
  const without = (field: "machine" | "model" | "effort"): AutoLaunchTags => {
    const next: AutoLaunchTags = { ...selected };
    delete next[field];
    return next;
  };
  const machines = autoLaunchCandidates(undefined, without("machine"), registrations)
    .filter(candidate => candidate.launchField === "machine" && candidate.launchTags?.machine)
    .map(candidate => ({
      value: candidate.launchTags!.machine!,
      label: candidate.name.replace(/^machine:/u, ""),
      ...(candidate.unavailable ? { unavailable: candidate.unavailable } : {}),
    }));
  const models = autoLaunchCandidates(undefined, without("model"), registrations)
    .filter(candidate => candidate.launchField === "model" && candidate.launchTags?.model)
    .map(candidate => ({
      value: candidate.launchTags!.model!,
      label: candidate.launchTags!.model!,
    }));
  const efforts = autoLaunchCandidates(undefined, without("effort"), registrations)
    .filter(candidate => candidate.launchField === "effort" && candidate.launchTags?.effort)
    .map(candidate => ({
      value: candidate.launchTags!.effort!,
      label: candidate.launchTags!.effort!,
    }));
  const withoutParams: AutoLaunchTags = { ...selected };
  delete withoutParams.parameters;
  const paramMap = new Map<string, HandoffPickerParameterGroup>();
  for (const candidate of autoLaunchCandidates(undefined, withoutParams, registrations)) {
    if (candidate.launchField !== "parameters" || !candidate.launchTags?.parameters) continue;
    for (const [id, value] of Object.entries(launchHarnessParameters(candidate.launchTags))) {
      const existing = paramMap.get(id) ?? { id, label: candidate.description || id, options: [] };
      if (!existing.options.some(option => option.value === value)) {
        existing.options.push({ value, label: value });
      }
      paramMap.set(id, existing);
    }
  }
  return { machines, models, efforts, parameters: [...paramMap.values()] };
}

/** Whether the Space's registrations offer any parameter beyond harness. */
export function handoffPickerHasOptions(registrations: readonly AgentRegistrationSummary[] = []): boolean {
  const params = handoffPickerParameters(registrations, {});
  return params.machines.length > 0 || params.models.length > 0 || params.efforts.length > 0 || params.parameters.length > 0;
}

/** Successors offered by the handoff picker under the currently chosen tags. */
export function compatibleHandoffSuccessors(
  registrations: readonly AgentRegistrationSummary[] = [],
  capabilityHarnesses: readonly string[] = [],
  selected: AutoLaunchTags = {},
): string[] {
  const hasTags = Boolean(selected.machine || selected.model || selected.effort || selected.parameters);
  if (!hasTags) {
    const names = capabilityHarnesses.map(harness => harness.trim().replace(/^[@＠]/u, ""))
      .filter(harness => harness && isHandoffSuccessorName(harness) && !isAutoHandoffSuccessor(harness));
    return names.length > 0 ? ["auto", ...new Set(names)] : [];
  }
  const harnesses = autoLaunchCandidates(undefined, selected, registrations)
    .filter(candidate => candidate.launchField === "harness" && candidate.launchTags?.harness)
    .map(candidate => candidate.launchTags!.harness!)
    .filter(harness => isHandoffSuccessorName(harness) && !isAutoHandoffSuccessor(harness));
  return harnesses.length > 0 ? ["auto", ...new Set(harnesses)] : [];
}

/** Toggle one parameter choice on a handoff picker's selected tags, dropping
 *  dependent choices that are no longer compatible with any registration. */
export function toggleHandoffPickerTag(
  selected: AutoLaunchTags,
  registrations: readonly AgentRegistrationSummary[],
  change: { field: "machine" | "model" | "effort"; value: string } | { field: "parameter"; parameterId: string; value: string },
): AutoLaunchTags {
  const next: AutoLaunchTags = { ...selected };
  if (change.field === "parameter") {
    const params = { ...launchHarnessParameters(next) };
    if (params[change.parameterId] === change.value) delete params[change.parameterId];
    else params[change.parameterId] = change.value;
    if (Object.keys(params).length) next.parameters = JSON.stringify(params);
    else delete next.parameters;
  } else if (next[change.field] === change.value) {
    delete next[change.field];
  } else {
    next[change.field] = change.value;
  }
  // Drop dependent selections that no registration still supports.
  if (next.effort) {
    const validEfforts = handoffPickerParameters(registrations, { ...next, effort: undefined }).efforts;
    if (!validEfforts.some(option => option.value === next.effort)) delete next.effort;
  }
  if (next.parameters) {
    const validGroups = handoffPickerParameters(registrations, { ...next, parameters: undefined }).parameters;
    const kept = Object.fromEntries(Object.entries(launchHarnessParameters(next)).filter(([id, value]) =>
      validGroups.some(group => group.id === id && group.options.some(option => option.value === value))));
    if (Object.keys(kept).length) next.parameters = JSON.stringify(kept);
    else delete next.parameters;
  }
  return next;
}

/** Compact chips summarizing the non-harness parameters chosen in the picker. */
export function handoffTagChips(tags: AutoLaunchTags): HandoffTagChip[] {
  const chips: HandoffTagChip[] = [];
  if (tags.machine) chips.push({ key: "machine", field: "machine", label: `machine:${tags.machine}` });
  if (tags.model) chips.push({ key: "model", field: "model", label: `model:${tags.model}` });
  if (tags.effort) chips.push({ key: "effort", field: "effort", label: `effort:${tags.effort}` });
  for (const [id, value] of Object.entries(launchHarnessParameters(tags))) {
    chips.push({ key: `param:${id}`, field: "parameter", parameterId: id, label: id === "fast" ? `fast:${value}` : `param.${id}:${value}` });
  }
  return chips;
}
