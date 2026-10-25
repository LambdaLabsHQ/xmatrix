import type { AgentBootstrapPrompts } from "@xmatrix/protocol";
import bootstrap from "../../cli-rs/crates/core/prompts/bootstrap.md";
import channelContract from "../../cli-rs/crates/core/prompts/channel-contract.md";
import channelTurn from "../../cli-rs/crates/core/prompts/channel-turn.md";
import goalCommand from "../../cli-rs/crates/core/prompts/goal-command.md";
import spaceRules from "../../cli-rs/crates/core/prompts/space-rules.md";
import connectedApps from "../../cli-rs/crates/core/prompts/connected-apps.md";
import workingModeAutonomous from "../../cli-rs/crates/core/prompts/working-mode-autonomous.md";
import workingModeCautious from "../../cli-rs/crates/core/prompts/working-mode-cautious.md";
import sessionRecovery from "../../cli-rs/crates/core/prompts/session-recovery.md";
import sessionRecoveryInput from "../../cli-rs/crates/core/prompts/session-recovery-input.md";
import sessionRecoveryReborn from "../../cli-rs/crates/core/prompts/session-recovery-reborn.md";
import sessionRecoveryQuiet from "../../cli-rs/crates/core/prompts/session-recovery-quiet.md";

/** Filled at the trusted daemon delivery boundary, never from a message,
 * registration instructions or caller-supplied command metadata. */
export const AGENT_BOOTSTRAP_PROMPTS: Readonly<AgentBootstrapPrompts> = Object.freeze({
  schemaVersion: 1, bootstrap, channelContract, channelTurn, goalCommand,
  spaceRules, connectedApps, workingModeAutonomous, workingModeCautious,
});

/** Daemon capability: it accepts `texts` in the bundle and looks them up by name. */
export const BOOTSTRAP_PROMPT_TEXTS_CAPABILITY = "bootstrap_prompt_texts_v1";

/** The bundle with the named official texts, for a daemon that declared it can read them. A daemon
 * that predates `texts` refuses an unknown field, so it keeps the fixed fields and its compiled copies. */
export const AGENT_BOOTSTRAP_PROMPTS_WITH_TEXTS: Readonly<AgentBootstrapPrompts> = Object.freeze({
  ...AGENT_BOOTSTRAP_PROMPTS,
  texts: Object.freeze({
    "session-recovery": sessionRecovery,
    "session-recovery-input": sessionRecoveryInput,
    "session-recovery-reborn": sessionRecoveryReborn,
    "session-recovery-quiet": sessionRecoveryQuiet,
  }),
});
