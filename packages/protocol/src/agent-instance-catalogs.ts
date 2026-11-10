import type { AgentInstanceCommand, AgentModelInfo } from "./authority-foundation.js";
import { plainRecord } from "./plain-record.js";

// The runtime writer and durable Instance reader use the same catalogs.
// Only declared presentation fields survive; an observed empty catalog stays empty.
// Lists keep every entry the runtime reports: a count cap silently hid the tail
// of a Claude command list (skills, plugins) from the menu. The presence body's
// byte bound is the only size limit.
export function cleanAgentCapabilities(value: unknown): string[] | undefined {
  return Array.isArray(value) ? cleanAgentPresentationTextList(value, 128) ?? [] : undefined;
}

export function cleanAgentModelCatalog(value: unknown): AgentModelInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Map<string, AgentModelInfo>();
  const models: AgentModelInfo[] = [];
  for (const candidate of value) {
    if (!record(candidate)) continue;
    const id = cleanAgentPresentationText(candidate.id, 128);
    const model = cleanAgentPresentationText(candidate.model, 128) || id;
    if (!id || !model) continue;
    // One entry per model; another selector for it is kept as that entry's alias.
    const names = [id, cleanAgentPresentationText(candidate.displayName, 128), ...cleanAgentPresentationTextList(candidate.aliases, 128) ?? []]
      .filter((name): name is string => Boolean(name));
    const known = seen.get(model.toLowerCase());
    if (known) {
      const aliases = [...new Set([...known.aliases ?? [], ...names])]
        .filter(name => name !== known.id && name !== known.model && name !== known.displayName);
      if (aliases.length) known.aliases = aliases;
      continue;
    }
    const efforts = Array.isArray(candidate.supportedReasoningEfforts)
      ? candidate.supportedReasoningEfforts.flatMap((effort) => {
          if (!record(effort)) return [];
          const reasoningEffort = cleanAgentPresentationText(effort.reasoningEffort, 64);
          return reasoningEffort
            ? [{
                reasoningEffort,
                ...(cleanAgentPresentationText(effort.description, 256)
                  ? { description: cleanAgentPresentationText(effort.description, 256) }
                  : {}),
              }]
            : [];
        })
      : undefined;
    const aliases = cleanAgentPresentationTextList(candidate.aliases, 128);
    const entry: AgentModelInfo = {
      id,
      model,
      ...(aliases?.length ? { aliases } : {}),
      ...(cleanAgentPresentationText(candidate.displayName, 128)
        ? { displayName: cleanAgentPresentationText(candidate.displayName, 128) }
        : {}),
      ...(cleanAgentPresentationText(candidate.description, 512)
        ? { description: cleanAgentPresentationText(candidate.description, 512) }
        : {}),
      ...(typeof candidate.hidden === "boolean" ? { hidden: candidate.hidden } : {}),
      ...(typeof candidate.isDefault === "boolean" ? { isDefault: candidate.isDefault } : {}),
      ...(cleanAgentPresentationText(candidate.defaultReasoningEffort, 64)
        ? { defaultReasoningEffort: cleanAgentPresentationText(candidate.defaultReasoningEffort, 64) }
        : {}),
      ...(efforts?.length ? { supportedReasoningEfforts: efforts } : {}),
      ...(cleanAgentPresentationTextList(candidate.inputModalities, 32)
        ? { inputModalities: cleanAgentPresentationTextList(candidate.inputModalities, 32) }
        : {}),
      ...(typeof candidate.supportsPersonality === "boolean"
        ? { supportsPersonality: candidate.supportsPersonality }
        : {}),
      ...(cleanAgentPresentationText(candidate.upgrade, 128) ? { upgrade: cleanAgentPresentationText(candidate.upgrade, 128) } : {}),
    };
    seen.set(model.toLowerCase(), entry);
    models.push(entry);
  }
  return models;
}

export function cleanAgentCommands(value: unknown): AgentInstanceCommand[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const commands: AgentInstanceCommand[] = [];
  for (const candidate of value) {
    if (!record(candidate)) continue;
    const rawToken = cleanAgentPresentationText(candidate.token, 64);
    if (!rawToken) continue;
    const token = rawToken.startsWith("/") ? rawToken : `/${rawToken}`;
    const key = token.toLowerCase();
    if (!/^\/[a-zA-Z][a-zA-Z0-9_-]{0,62}$/u.test(token) || seen.has(key)) continue;
    seen.add(key);
    const mode = candidate.mode === "typed" || candidate.mode === "passthrough"
      ? candidate.mode
      : undefined;
    const argumentSource = candidate.argumentSource === "agent-models" ||
        candidate.argumentSource === "agent-efforts"
      ? candidate.argumentSource
      : undefined;
    commands.push({
      token,
      label: cleanAgentPresentationText(candidate.label, 64) || token.slice(1),
      ...(cleanAgentPresentationText(candidate.description, 256)
        ? { description: cleanAgentPresentationText(candidate.description, 256) }
        : {}),
      ...(mode ? { mode } : {}),
      ...(argumentSource ? { argumentSource } : {}),
      ...(typeof candidate.freeform === "boolean" ? { freeform: candidate.freeform } : {}),
    });
  }
  return commands;
}

export function cleanAgentPresentationText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

export function cleanAgentPresentationTextList(value: unknown, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const clean = value
    .map((item) => cleanAgentPresentationText(item, maxLength))
    .filter((item): item is string => Boolean(item));
  return clean.length > 0 ? [...new Set(clean)] : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return plainRecord(value) !== undefined;
}
