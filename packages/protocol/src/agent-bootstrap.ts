/** Official repository text delivered by the Hub, separate from task/user content.
 * Version 1 uses one-pass {slot} rendering in the CLI. Missing means the
 * daemon's compiled compatibility copy; an unsupported version fails launch. */
export interface AgentBootstrapPrompts {
  schemaVersion: 1;
  bootstrap: string;
  channelContract: string;
  channelTurn: string;
  goalCommand: string;
  spaceRules: string;
  connectedApps: string;
  workingModeAutonomous: string;
  workingModeCautious: string;
}
