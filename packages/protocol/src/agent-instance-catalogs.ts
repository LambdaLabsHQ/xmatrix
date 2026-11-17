import type { AgentInstanceCommand, AgentModelInfo } from "./authority-foundation.js";
import { hasControlCharacter } from "./field-validation.js";
import { plainRecord } from "./plain-record.js";

// The runtime writer and durable Instance reader use the same catalogs.
// Only declared presentation fields survive; an observed empty catalog stays empty.
// Lists keep every entry the runtime reports: a count cap silently hid the tail
// of a Claude command list (skills, plugins) from the menu. The presence body's
// byte bound is the only size limit.
export function cleanAgentCapabilities(value: unknown): string[] | undefined {
  return Array.isArray(value) ? cleanAgentPresentationTextList(value, 128) ?? [] : undefined;
}

function cleanCatalogIdentifier(value: unknown, maxLength: number): string | undefined {
  const clean = cleanAgentPresentationText(value, maxLength);
  return clean && !hasControlCharacter(clean) ? clean : undefined;
}

export function cleanAgentModelCatalog(value: unknown): AgentModelInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Map<string, AgentModelInfo>();
  const models: AgentModelInfo[] = [];
  for (const candidate of value) {
    if (!record(candidate)) continue;
    const rawId = cleanCatalogIdentifier(candidate.id, 160);
    const model = cleanCatalogIdentifier(candidate.model, 160) || rawId;
    const id = rawId || model;
    if (!id || !model) continue;
    const displayName = cleanCatalogIdentifier(candidate.displayName, 160);
    const rawAliases = (Array.isArray(candidate.aliases) ? candidate.aliases : [])
      .map(alias => cleanCatalogIdentifier(alias, 160))
      .filter((alias): alias is string => Boolean(alias));
    // One entry per model; another selector for it is kept as that entry's alias.
    const names = [id, displayName, ...rawAliases]
      .filter((name): name is string => Boolean(name));
    const known = seen.get(model.toLowerCase());
    if (known) {
      const aliases = [...new Set([...known.aliases ?? [], ...names])]
        .filter(name => name !== known.id && name !== known.model && name !== known.displayName);
      if (aliases.length) known.aliases = aliases;
      if (candidate.isDefault === true) known.isDefault = true;
      continue;
    }
    const efforts = Array.isArray(candidate.supportedReasoningEfforts)
      ? candidate.supportedReasoningEfforts.flatMap((effort) => {
          if (!record(effort)) return [];
          const reasoningEffort = cleanCatalogIdentifier(effort.reasoningEffort, 80);
          const description = cleanAgentPresentationText(effort.description, 512);
          return reasoningEffort
            ? [{
                reasoningEffort,
                ...(description ? { description } : {}),
              }]
            : [];
        })
      : undefined;
    const aliases = rawAliases.length ? [...new Set(rawAliases)] : undefined;
    const quotaScopes = (Array.isArray(candidate.quotaScopes) ? candidate.quotaScopes : [])
      .map(scope => cleanCatalogIdentifier(scope, 64))
      .filter((scope): scope is string => Boolean(scope));
    const description = cleanAgentPresentationText(candidate.description, 512);
    const defaultReasoningEffort = cleanCatalogIdentifier(candidate.defaultReasoningEffort, 80);
    const inputModalities = cleanAgentPresentationTextList(candidate.inputModalities, 32);
    const upgrade = cleanCatalogIdentifier(candidate.upgrade, 160);
    const entry: AgentModelInfo = {
      id,
      model,
      ...(aliases?.length ? { aliases } : {}),
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      ...(typeof candidate.hidden === "boolean" ? { hidden: candidate.hidden } : {}),
      ...(typeof candidate.isDefault === "boolean" ? { isDefault: candidate.isDefault } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      ...(efforts?.length ? { supportedReasoningEfforts: efforts } : {}),
      ...(inputModalities ? { inputModalities } : {}),
      ...(typeof candidate.supportsPersonality === "boolean"
        ? { supportsPersonality: candidate.supportsPersonality }
        : {}),
      ...(upgrade ? { upgrade } : {}),
      ...(quotaScopes.length ? { quotaScopes: [...new Set(quotaScopes)] } : {}),
    };
    seen.set(model.toLowerCase(), entry);
    models.push(entry);
  }
  return models;
}

/**
 * The catalog entry a running model is: the one whose id it is, else the one
 * it otherwise names (model, display name or an alias, ignoring case), or the
 * runtime's default entry when it names none. An alias can stand for several
 * entries (Claude's `default` resolves to the model `opus` also names), so an
 * exact selector wins. None when the catalog does not list it.
 */
export function agentModelEntry(models: readonly AgentModelInfo[] | undefined,
  model: string | undefined): AgentModelInfo | undefined {
  const wanted = model?.trim().toLowerCase();
  if (!wanted) return models?.find(entry => entry.isDefault);
  const named = (name: string | undefined) => name?.trim().toLowerCase() === wanted;
  return models?.find(entry => named(entry.id)) ??
    models?.find(entry => [entry.model, entry.displayName, ...entry.aliases ?? []].some(named));
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
