import type { ConnectorActionStatement } from "./provider";

export { parseConnectorActionCommand as parseActionCommand,
  type ParsedConnectorActionCommand as ParsedActionCommand } from "@xmatrix/protocol";

export type PolicyCommand = { actionId: string; mode: "allow" | "deny" | null } | { error: string };

export function parsePolicyCommand(statement: ConnectorActionStatement): PolicyCommand {
  const actionId = statement.target.toLowerCase();
  const word = statement.text.split(/\s+/u)[0]?.toLowerCase() ?? "";
  if (!/^[a-z_]{1,100}$/u.test(actionId)) return { error: "name the action: @<provider>:policy:<action> allow|deny|default" };
  if (word === "allow" || word === "deny") return { actionId, mode: word };
  if (word === "default" || word === "reset") return { actionId, mode: null };
  return { error: "policy is allow, deny, or default" };
}
