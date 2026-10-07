/**
 * Visible Channel stop command for a live Instance card.
 *
 * Scoped control authorities do not host live `agent_list` inventory. The work-dock card
 * already carries the Channel address (`label` + `channelInstanceId`), so Stop
 * must not depend on a catalog lookup the way Reborn already does not.
 * The ordinal is unique within the Channel, so `name:ordinal` needs no Profile id.
 */

export function agentInstanceStopBody(
  agent: { name?: string } | undefined,
  instance: { label?: string; channelInstanceId?: string },
  fallbackName?: string,
): string | null {
  const ordinal = instance.channelInstanceId?.trim();
  if (!ordinal || !/^[1-9]\d*$/.test(ordinal)) return null;
  const name = channelStopMentionName(agent?.name, fallbackName, instance.label, ordinal);
  if (!name) return null;
  return `@${name}:${ordinal}:stop`;
}

function channelStopMentionName(
  agentName: string | undefined,
  fallbackName: string | undefined,
  instanceLabel: string | undefined,
  ordinal: string,
): string | null {
  for (const candidate of [
    mentionNameFromInstanceLabel(instanceLabel, ordinal),
    agentName,
    fallbackName,
  ]) {
    const name = (candidate || "").trim().replace(/^[@＠]/, "");
    if (!name || name.toLowerCase() === "xmatrix" || name.includes(":")) continue;
    return name;
  }
  return null;
}

function mentionNameFromInstanceLabel(
  label: string | undefined,
  ordinal: string,
): string | null {
  const trimmed = (label || "").trim().replace(/^[@＠]/, "");
  const suffix = `:${ordinal}`;
  if (trimmed.length <= suffix.length) return null;
  if (!trimmed.toLowerCase().endsWith(suffix.toLowerCase())) return null;
  const name = trimmed.slice(0, -suffix.length).trim();
  return name || null;
}
