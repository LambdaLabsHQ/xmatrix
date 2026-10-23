import type { AgentBootstrapPrompts } from "@xmatrix/protocol";
import bootstrap from "../../cli-rs/crates/core/prompts/bootstrap.md";
import channelContract from "../../cli-rs/crates/core/prompts/channel-contract.md";
import channelTurn from "../../cli-rs/crates/core/prompts/channel-turn.md";
import goalCommand from "../../cli-rs/crates/core/prompts/goal-command.md";
import spaceRules from "../../cli-rs/crates/core/prompts/space-rules.md";
import connectedApps from "../../cli-rs/crates/core/prompts/connected-apps.md";
import workingModeAutonomous from "../../cli-rs/crates/core/prompts/working-mode-autonomous.md";
import workingModeCautious from "../../cli-rs/crates/core/prompts/working-mode-cautious.md";

/** Filled at the trusted daemon delivery boundary, never from a message,
 * registration instructions or caller-supplied command metadata. */
export const AGENT_BOOTSTRAP_PROMPTS: Readonly<AgentBootstrapPrompts> = Object.freeze({
  schemaVersion: 1, bootstrap, channelContract, channelTurn, goalCommand,
  spaceRules, connectedApps, workingModeAutonomous, workingModeCautious,
});
