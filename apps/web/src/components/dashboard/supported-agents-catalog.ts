import { AGENT_PRESETS, type AgentPreset } from "@xmatrix/protocol";
import type { InstallPlatform } from "./connect-machine";
import { harnessCommandLabel } from "./machine-harness-state";

/* Every agent xMatrix can bring in, so a newcomer finds the one they already
   use instead of reading that only two are welcome. The registry is the
   source: a harness added there appears here without a code change. The ones
   most people arrive with lead, so the first line is recognisable at a glance. */

export const LEADING_AGENT_IDS = ["claude", "codex", "cursor", "gemini", "copilot", "kimi", "qwen", "trae", "qoder", "codebuddy"];

function leadRank(preset: AgentPreset): number {
  const rank = LEADING_AGENT_IDS.indexOf(preset.id);
  return rank < 0 ? LEADING_AGENT_IDS.length : rank;
}

export const SUPPORTED_AGENTS: AgentPreset[] = AGENT_PRESETS
  .filter((preset) => preset.id !== "custom" && preset.avatarUrl)
  .sort((a, b) => leadRank(a) - leadRank(b));

/**
 * The upstream installer as a person pastes it: the script, not the shell
 * wrapping it. Only a verified recipe counts; a prose hint cannot be pasted.
 */
export function agentInstallCommand(preset: AgentPreset, platform: InstallPlatform): string | undefined {
  const recipe = preset.management?.install[platform];
  if (!recipe) return undefined;
  const script = recipe.command === "powershell" ? recipe.args[recipe.args.indexOf("-Command") + 1]
    : (recipe.command === "bash" || recipe.command === "sh") && recipe.args[0] === "-c" ? recipe.args[1] : undefined;
  return script ?? harnessCommandLabel(recipe);
}
