export const AGENT_RUN_PERMISSION_CHANNEL_ATTACHMENTS_WRITE =
  "channel.attachments.write" as const;

export const AGENT_RUN_PERMISSIONS = Object.freeze([
  AGENT_RUN_PERMISSION_CHANNEL_ATTACHMENTS_WRITE,
] as const);

export type AgentRunPermission = (typeof AGENT_RUN_PERMISSIONS)[number];

const AGENT_RUN_PERMISSION_SET = new Set<string>(AGENT_RUN_PERMISSIONS);

/**
 * Agent Run permissions are a closed product-security catalog. Unknown,
 * duplicate, or non-string metadata never expands an Agent principal.
 */
export function parseAgentRunPermissions(value: unknown): AgentRunPermission[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.filter(
      (permission): permission is AgentRunPermission =>
        typeof permission === "string" && AGENT_RUN_PERMISSION_SET.has(permission),
    ),
  )];
}

/**
 * Product default when an Agent has no explicit permission setting.
 * Channel file/image upload is granted by default for every sandbox mode;
 * sandboxMode only bounds local filesystem access and does not strip this
 * product capability. Explicit agentRunPermissions (including []) override
 * when stamped with AGENT_RUN_PERMISSIONS_POLICY_VERSION.
 */
export function defaultAgentRunPermissions(): AgentRunPermission[] {
  return [AGENT_RUN_PERMISSION_CHANNEL_ATTACHMENTS_WRITE];
}
