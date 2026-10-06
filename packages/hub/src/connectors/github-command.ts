/* The GitHub actions a channel message runs. Which of them may run in a given
   Channel, and by whom, is the action policy's decision
   (docs/design/connector-platform.md §3.5). */
export const GITHUB_COMMAND_ACTIONS = [
  "subscribe", "unsubscribe", "merge", "rerun_failed_jobs", "dispatch_workflow",
  "comment", "create_issue", "close_issue", "reopen_issue", "review", "policy",
] as const;

const GITHUB_COMMAND = new RegExp(
  `^\\s*[@＠][\\u200B-\\u200D\\uFEFF]*github:(?:${GITHUB_COMMAND_ACTIONS.join("|")})\\b`, "iu");

/** Whether a committed message's leading statement is a GitHub command this Hub runs. */
export function isGitHubConnectorCommand(body: string): boolean {
  return GITHUB_COMMAND.test(body);
}
