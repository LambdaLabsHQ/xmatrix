import type { AgentWorkingMode, SpaceAgentConfiguration } from "@xmatrix/protocol";

/** The spawn fields a registration's configuration gives its Run: the Space's
 * own instructions, as the Run's trusted initial prompt, and its working mode. The wire field keeps
 * its `roleInitialPrompt` spelling because every daemon reads it. The Agent
 * Role it once also carried is retired: a launch reads no `role_json`. */
export function registrationInstructionsSpawnFields(configuration: SpaceAgentConfiguration):
  { roleInitialPrompt?: string; workingMode?: AgentWorkingMode } {
  return {
    ...(configuration.instructions ? { roleInitialPrompt: configuration.instructions } : {}),
    ...(configuration.workingMode ? { workingMode: configuration.workingMode } : {}),
  };
}
