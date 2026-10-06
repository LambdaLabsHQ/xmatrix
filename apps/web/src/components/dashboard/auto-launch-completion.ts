import { registrationMachineName } from "./machine-name-presentation";
import {
  AUTO_LAUNCH_FIELDS,
  launchHarnessParameters,
  formatAutoLaunchMention,
  machineLaunchTagValue,
  machineMentionValue,
  parseAutoLaunchMentions,
  type AutoLaunchField,
  type AutoLaunchMention,
  type AutoLaunchTags,
  type AgentRegistrationSummary,
  type SpaceLaunchTargetsResponse,
} from "@xmatrix/protocol";
import type { ActiveMention, MentionCandidate } from "./mention-complete";

/** Field text is completion syntax only inside an unfinished summon, never in ordinary prose. */
export function findLaunchFieldCompletion(body: string, cursor: number): ActiveMention | null {
  if (cursor < 0) return null;
  const before = body.slice(0, cursor);
  const match = /(?:^|\s)([a-zA-Z][a-zA-Z0-9_.-]*)(?::("(?:[^"]|"")*"?|[^\s]*))?$/u.exec(before);
  if (!match) return null;
  const field = match[1]!;
  const hasColon = match[0].includes(":");
  if (!field.startsWith("param.") && field !== "param" && field !== "fast" && !AUTO_LAUNCH_FIELDS.some(key => key !== "parameters" && (hasColon ? key === field : key.startsWith(field)))) return null;
  const start = match.index + (/^\s/u.test(match[0]) ? 1 : 0);
  const prefix = body.slice(0, start);
  if (!summonAtCompletion(prefix, start)) return null;
  let tokenEnd = cursor;
  // Replace the whole field when editing in its middle, including quoted paths.
  let quoted = false;
  for (let index = start; index < body.length; index++) {
    const char = body[index];
    if (char === '"') {
      if (quoted && body[index + 1] === '"') { index++; continue; }
      quoted = !quoted;
    }
    if (!quoted && /\s/u.test(char!)) { tokenEnd = Math.max(cursor, index); break; }
    tokenEnd = index + 1;
  }
  return { start, end: cursor, tokenEnd, query: before.slice(start) };
}

export function filterLaunchCandidates(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  const separator = query.indexOf(":");
  const field = query.slice(0, separator);
  if (separator >= 0 && (field.startsWith("param.") || field === "fast")) {
    const id = field === "fast" ? "fast" : field.slice(6);
    const value = query.slice(separator + 1).replace(/^"|"$/gu, "").replaceAll('""', '"').toLowerCase();
    return candidates.filter(candidate => {
      const selected = candidate.launchTags && launchHarnessParameters(candidate.launchTags)[id];
      return selected !== undefined && selected.toLowerCase().includes(value);
    });
  }
  if (separator >= 0 && AUTO_LAUNCH_FIELDS.some(key => key === field)) {
    const value = query.slice(separator + 1).replace(/^"|"$/gu, "").replaceAll('""', '"').toLowerCase();
    return candidates.filter(candidate => {
      const tags = candidate.launchTags;
      const tag = tags?.[field as AutoLaunchField];
      return tag !== undefined && `${tag} ${candidate.name}`.toLowerCase().includes(value);
    });
  }
  return candidates.filter(candidate => `${candidate.name} ${candidate.description}`.toLowerCase().includes(query.toLowerCase()));
}

/** One name per launch field. Composer chips and completion rows both read it. */
export const AUTO_LAUNCH_FIELD_LABEL: Record<AutoLaunchField, string> = {
  repo: "Repository",
  pwd: "Directory",
  machine: "Machine",
  model: "Model",
  effort: "Reasoning effort",
  harness: "Harness",
  launch: "Launch",
  parameters: "Harness parameter",
};

/** Suggestions use visible catalog facts. Selecting a label never grants access. */
export function autoLaunchCandidates(targets: SpaceLaunchTargetsResponse | undefined,
  selected: AutoLaunchTags = {}, registrations: readonly AgentRegistrationSummary[] = []): MentionCandidate[] {
  const result: MentionCandidate[] = [{ id: "launch:auto", name: "Auto", kind: "launch", status: "offline",
    description: "Choose an Agent automatically", launchTags: {} }];
  const seen = new Set<string>();
  const onlineMachines = new Set<string>();
  const offlineMachines = new Set<string>();
  for (const registration of registrations) {
    const online = registration.live?.machine.online;
    if (online === true) onlineMachines.add(registration.key.machineId);
    else if (online === false) offlineMachines.add(registration.key.machineId);
  }
  for (const machineId of onlineMachines) offlineMachines.delete(machineId);
  const add = (field: keyof AutoLaunchTags, value: string, label = value, extra: AutoLaunchTags = {}, unavailable?: string) => {
    // One value per condition: once a field is set, that field offers no more
    // options. The human removes it from the message to choose another.
    if (selected[field] !== undefined) return;
    // A repository and a directory are one choice of where to work; a summon
    // that names either can no longer take the other.
    if ((field === "repo" || field === "pwd") && (selected.repo !== undefined || selected.pwd !== undefined)) return;
    const id = `launch:${field}:${value}:${extra.machine ?? ""}`;
    if (seen.has(id)) return;
    seen.add(id);
    result.push({ id, name: field === "harness" ? `@${label}` : `${field}:${label}`, kind: "launch", status: "offline",
      description: unavailable ?? AUTO_LAUNCH_FIELD_LABEL[field], ...(unavailable ? { unavailable } : {}),
      launchTags: { [field]: value, ...extra } });
  };
  for (const repo of targets?.repos ?? []) add("repo", repo.value);
  // A directory names its Machine as the owner did; a hostname never selects one.
  for (const workspace of targets?.workspaces ?? []) {
    if (!selected.machine || selected.machine === workspace.machineId) {
      const machineName = registrationMachineName(registrations, workspace.machineId, workspace.ownerUserId) ?? "";
      const machine = machineMentionValue(workspace.machineId, machineName);
      add("pwd", workspace.canonicalCwd, `${workspace.canonicalCwd} · ${machine === workspace.machineId
        ? machineLaunchTagValue(workspace.machineId) : machine}`, { machine },
        offlineMachines.has(workspace.machineId) ? "Offline" : undefined);
    }
  }
  for (const registration of registrations) {
    const { machineId, harness } = registration.key;
    if (registration.state !== "enabled" || !registration.routingReady ||
        selected.machine && selected.machine !== machineId ||
        selected.harness && selected.harness !== harness) continue;
    // Allowed models are the complete list; an empty list allows only the
    // runtime default, so no model or effort is offered for it.
    const allowed = registration.models;
    const observed = (registration.modelCatalog ?? []).filter(model => model.model && allowed.includes(model.model));
    const reported = observed.map(model => model.model);
    if (selected.model && !allowed.includes(selected.model)) continue;
    const spoken = machineMentionValue(machineId, registration.machineName);
    add("machine", spoken, spoken === machineId ? machineLaunchTagValue(machineId) : registration.machineName,
      {}, offlineMachines.has(machineId) ? "Offline" : undefined);
    add("harness", harness);
    const selectedParameters = launchHarnessParameters(selected);
    for (const parameter of registration.parameters ?? []) {
      if (selectedParameters[parameter.id] !== undefined || ["model", "models", "effort", "reasoning_effort"].includes(parameter.id) ||
          selected.model && registration.parameterModel && selected.model !== registration.parameterModel) continue;
      for (const value of parameter.options) {
        const id = `launch:parameter:${parameter.id}:${value}`;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({ id, name: `param.${parameter.id}:${value}`, kind: "launch", status: "offline", description: parameter.label,
          launchTags: { parameters: JSON.stringify({ [parameter.id]: value }) } });
      }
    }
    for (const model of reported.length ? reported : allowed) add("model", model);
    for (const model of observed) {
      if (selected.model && selected.model !== model.model) continue;
      for (const effort of model.efforts) add("effort", effort.value);
    }
  }
  add("launch", "force", "force · Start without Jev's intent check");
  return result;
}

/**
 * A fresh `@` names who to summon, so it offers only runtimes (and Auto), listed
 * with the other Agents. Repository, directory, machine, model and effort are
 * conditions on a summon: they are offered once the summon exists, typed after it.
 */
export function summonStartCandidates(candidates: MentionCandidate[]): MentionCandidate[] {
  return candidates.filter(candidate => candidate.id === "launch:auto" || candidate.launchTags?.harness !== undefined)
    .map(candidate => ({ ...candidate, kind: "agent" }));
}

/** Only an explicit completion replaces the active fragment; surrounding text is immutable. */
export function completeLaunchFragment(body: string, active: ActiveMention, picked: AutoLaunchTags) {
  const prefix = body.slice(0, active.start);
  const hasConditions = Object.keys(picked).length > 0;
  const summon = summonAtCompletion(prefix, active.start);
  if (picked.harness) {
    const start = summon?.start ?? active.start;
    const fragment = formatAutoLaunchMention({ ...summon?.tags, ...picked }, true);
    const suffix = body.slice(active.tokenEnd);
    const inserted = fragment + (/^\s/u.test(suffix) ? "" : " ");
    return { value: body.slice(0, start) + inserted + suffix, cursor: start + inserted.length };
  }
  const canonical = formatAutoLaunchMention(picked);
  // A condition after a summon is just a field. A fresh Auto selection always
  // inserts a new summon, including beside another summon.
  const fragment = hasConditions && summon
    ? canonical.slice("@auto ".length) : canonical;
  const suffix = body.slice(active.tokenEnd);
  const inserted = fragment + (/^\s/u.test(suffix) ? "" : " ");
  return { value: prefix + inserted + suffix, cursor: prefix.length + inserted.length };
}

/**
 * The summon a condition typed at `tokenStart` is being added to.
 *
 * A message may summon several Agents, so a picked condition belongs to the
 * summon it was typed onto — the one this `@` word continues — rather than to
 * whichever summon happens to come first. Only whitespace may separate them:
 * once a word intervenes, the author has moved on and is writing a new one.
 */
export function summonAtCompletion(body: string, tokenStart: number): AutoLaunchMention | undefined {
  const summons = parseAutoLaunchMentions(body);
  for (let index = summons.length - 1; index >= 0; index--) {
    const summon = summons[index]!;
    if (summon.end > tokenStart) continue;
    return summon.error || /\S/u.test(body.slice(summon.end, tokenStart)) ? undefined : summon;
  }
  return undefined;
}
