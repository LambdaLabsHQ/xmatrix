/**
 * Cross-machine handoff export (docs/same-machine-instance-handoff.md §2.1).
 * A stop may ask the Run's daemon to push its whole checkout, committed or
 * not, to a branch in this namespace, so a successor on another machine can
 * continue from it. The daemon refuses any other branch.
 */
export const HANDOFF_BRANCH_PREFIX = "xmatrix/handoff/";

export interface MachineHandoffExport {
  branch: string;
  /** The Channel whose Space's GitHub connection authorizes the push. */
  channelId: string;
}

export interface MachineHandoffExportResult {
  branch: string;
  state: "pushed" | "failed";
  commit?: string;
  /** The commit the checkout was on before its uncommitted work was added. */
  base?: string;
  /** Whether uncommitted changes were captured in `commit`. */
  dirty: boolean;
  error?: string;
}
