/**
 * The curated layer above harness discovery. Runtimes report every native
 * parameter they find; only the ones listed here become status tags, under the
 * name and icon chosen here. A harness parameter that is worth showing is
 * enabled by adding a row, not by changing code. Parameters left out remain
 * readable and settable through `/config`; they just never become a tag.
 */

/** Icon names a client maps once to its own icon set. */
export type StatusTagIcon = "model" | "effort" | "owner" | "machine" | "repo" | "workspace" | "name" | "fast";

export interface ParameterTagRule {
  /** Stable tag key; the tag id is `parameter:<key>`. */
  key: string;
  /** Name shown on the tag, whatever the harness calls the parameter. */
  label: string;
  icon: StatusTagIcon;
  /** Native parameter ids, from any harness, that this tag presents. */
  parameterIds: readonly string[];
}

export const PARAMETER_TAG_PREFIX = "parameter:";

export const PARAMETER_TAG_RULES: readonly ParameterTagRule[] = [
  { key: "fast", label: "Fast", icon: "fast", parameterIds: ["fast"] },
];

/** Tags that are not parameters keep their own fixed ids. */
const FIXED_TAG_ICONS: Readonly<Record<string, StatusTagIcon>> = {
  model: "model",
  effort: "effort",
  owner: "owner",
  machine: "machine",
  repo: "repo",
  workspace: "workspace",
  name: "name",
};

export function parameterTagRule(parameterId: string): ParameterTagRule | undefined {
  return PARAMETER_TAG_RULES.find(rule => rule.parameterIds.includes(parameterId));
}

/** The icon a tag id is drawn with, if the registry names one. */
export function statusTagIcon(tagId: string): StatusTagIcon | undefined {
  const id = tagId.toLowerCase();
  if (id.startsWith(PARAMETER_TAG_PREFIX)) {
    const key = id.slice(PARAMETER_TAG_PREFIX.length);
    return PARAMETER_TAG_RULES.find(rule => rule.key === key)?.icon;
  }
  return FIXED_TAG_ICONS[id];
}

/**
 * A parameter tag the registry does not list. Stored presentations and message
 * snapshots from before a parameter left (or never entered) the registry still
 * carry such tags; every reader drops them.
 */
export function isUnlistedParameterTag(tagId: string): boolean {
  const id = tagId.toLowerCase();
  return id.startsWith(PARAMETER_TAG_PREFIX) &&
    !PARAMETER_TAG_RULES.some(rule => rule.key === id.slice(PARAMETER_TAG_PREFIX.length));
}
