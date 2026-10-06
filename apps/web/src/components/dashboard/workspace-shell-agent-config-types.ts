import type { AgentPresetId, AgentRoutingDeclaration } from "@xmatrix/protocol";

/** The New agent form: a harness preset on this machine, added to a Space. */
export type AgentConfigForm = {
  routing?: AgentRoutingDeclaration;
  spaceId: string;
  presetId: AgentPresetId;
  name: string;
  runtime: string;
  argsText: string;
};
